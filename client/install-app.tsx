import { useEffect, useState } from 'react';
import { Share, X } from 'lucide-react';
import { BrandMark } from './brand.js';

type InstallEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> };

const SEEN_KEY = 'encore-install-seen';
const SAVED_KEY = 'encore-first-card-saved';
const SAVED_EVENT = 'gather:first-card-saved';

function installed() {
  return window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}
function read(key: string) { try { return window.localStorage.getItem(key) === '1'; } catch { return false; } }
function remember(key: string) { try { window.localStorage.setItem(key, '1'); } catch { /* Private mode: the card may show again next visit. */ } }

/** Called after a card is saved. The install offer waits for this, so it arrives once someone has seen the app is useful. */
export function markCardSaved() {
  if (read(SAVED_KEY)) return;
  remember(SAVED_KEY);
  window.dispatchEvent(new Event(SAVED_EVENT));
}

/** Offers to add Encore to the home screen, once, after the first saved card. Android and desktop Chrome get a real install button; iPhones get the steps. */
export function InstallPrompt() {
  const [event, setEvent] = useState<InstallEvent | null>(null);
  const [earned, setEarned] = useState(() => read(SAVED_KEY));
  const [hidden, setHidden] = useState(() => installed() || read(SEEN_KEY));
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) && !/crios|fxios/i.test(navigator.userAgent);

  useEffect(() => {
    const onPrompt = (next: Event) => { next.preventDefault(); setEvent(next as InstallEvent); };
    const onInstalled = () => { remember(SEEN_KEY); setHidden(true); };
    const onSaved = () => setEarned(true);
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    window.addEventListener(SAVED_EVENT, onSaved);
    return () => { window.removeEventListener('beforeinstallprompt', onPrompt); window.removeEventListener('appinstalled', onInstalled); window.removeEventListener(SAVED_EVENT, onSaved); };
  }, []);

  if (hidden || !earned || (!event && !ios)) return null;
  function close() { remember(SEEN_KEY); setHidden(true); }
  async function install() {
    if (!event) return;
    await event.prompt();
    await event.userChoice.catch(() => undefined);
    setEvent(null); close();
  }
  return <aside className="install-card" aria-label="Install Encore">
    <button type="button" className="icon-button install-close" aria-label="Not now" onClick={close}><X size={16} aria-hidden="true" /></button>
    <BrandMark size={44} />
    <div className="install-copy">
      <strong>Your first card is saved.</strong>
      <span>Keep Encore on your home screen: it opens in one tap, and cards you scan without signal wait safely on the phone.</span>
      {!event && <span className="install-steps">Tap <Share size={13} aria-hidden="true" /> Share, then “Add to Home Screen”.</span>}
    </div>
    <div className="install-actions">{event && <button type="button" className="button primary" onClick={() => void install()}>Install Encore</button>}<button type="button" className="button secondary" onClick={close}>{event ? 'Not now' : 'Got it'}</button></div>
  </aside>;
}
