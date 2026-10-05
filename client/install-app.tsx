import { useEffect, useState } from 'react';
import { Download, Share, X } from 'lucide-react';

type InstallEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> };

const DISMISS_KEY = 'gather-install-dismissed';
const DISMISS_DAYS = 30;

function installed() {
  return window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}
function dismissedRecently() {
  try { const at = Number(window.localStorage.getItem(DISMISS_KEY)); return at > 0 && Date.now() - at < DISMISS_DAYS * 86_400_000; } catch { return false; }
}

/** Offers to add Encore to the home screen. Android and desktop Chrome get a real install button; iPhones get the steps. */
export function InstallPrompt() {
  const [event, setEvent] = useState<InstallEvent | null>(null);
  const [hidden, setHidden] = useState(() => installed() || dismissedRecently());
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) && !/crios|fxios/i.test(navigator.userAgent);

  useEffect(() => {
    const onPrompt = (next: Event) => { next.preventDefault(); setEvent(next as InstallEvent); };
    const onInstalled = () => setHidden(true);
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => { window.removeEventListener('beforeinstallprompt', onPrompt); window.removeEventListener('appinstalled', onInstalled); };
  }, []);

  if (hidden || (!event && !ios)) return null;
  function dismiss() {
    try { window.localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch { /* The prompt may simply show again later. */ }
    setHidden(true);
  }
  async function install() {
    if (!event) return;
    await event.prompt();
    const choice = await event.userChoice.catch(() => ({ outcome: 'dismissed' as const }));
    if (choice.outcome === 'accepted') setHidden(true); else dismiss();
    setEvent(null);
  }
  return <aside className="install-prompt" aria-label="Install Encore">
    <Download size={19} aria-hidden="true" />
    <div>
      <strong>Add Encore to your home screen</strong>
      <span>{event ? 'Opens in one tap and keeps photos safe if the signal drops at an event.' : <>Tap <Share size={13} aria-hidden="true" /> Share, then “Add to Home Screen”. It opens in one tap and keeps photos safe if the signal drops.</>}</span>
    </div>
    {event && <button type="button" className="button primary" onClick={() => void install()}>Install</button>}
    <button type="button" className="icon-button install-close" aria-label="Not now" onClick={dismiss}><X size={16} aria-hidden="true" /></button>
  </aside>;
}
