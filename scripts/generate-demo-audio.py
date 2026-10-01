"""Generate spoken Gather voice-note fixtures with the installed Windows SAPI voice."""

from __future__ import annotations

import json
import wave
from pathlib import Path

import pythoncom
import win32com.client


ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / "public" / "demo"
NOTES = [
    {
        "id": "a1000000-0000-4000-8000-000000000001",
        "workspaceId": "demo-northstar",
        "contactId": "demo-ns-contact-1",
        "encounterId": "demo-encounter-1",
        "file": "sample-voice-note-tessa.wav",
        "transcript": "Interested in a small sample run after the event.",
    },
    {
        "id": "a1000000-0000-4000-8000-000000000002",
        "workspaceId": "demo-sam-space",
        "contactId": "demo-sam-contact-1",
        "encounterId": "demo-encounter-sam-private",
        "file": "sample-voice-note-sam.wav",
        "transcript": "Supplier minimum order is 250 units. They promised a printed sample by Tuesday.",
    },
    {
        "id": "a1000000-0000-4000-8000-000000000003",
        "workspaceId": "demo-riley-space",
        "contactId": "demo-riley-contact-1",
        "encounterId": "demo-encounter-riley-private",
        "file": "sample-voice-note-riley.wav",
        "transcript": "Met at the partner booth. Follow up about the next supplier introduction.",
    },
]


def generate() -> None:
    if not hasattr(win32com.client, "Dispatch"):
        raise RuntimeError("Install pywin32 before generating the Windows speech fixtures.")
    OUTPUT.mkdir(parents=True, exist_ok=True)
    pythoncom.CoInitialize()
    try:
        voice_probe = win32com.client.Dispatch("SAPI.SpVoice")
        voices = voice_probe.GetVoices()
        zira = next((voices.Item(i) for i in range(voices.Count) if "Zira" in voices.Item(i).GetDescription()), None)
        if zira is None:
            raise RuntimeError("The Microsoft Zira English voice is not installed on this computer.")

        for note in NOTES:
            target = OUTPUT / note["file"]
            staging = target.with_name(f"{target.stem}.partial.wav")
            voice = win32com.client.Dispatch("SAPI.SpVoice")
            voice.Voice = zira
            voice.Rate = 0
            voice.Volume = 85
            stream = win32com.client.Dispatch("SAPI.SpFileStream")
            try:
                stream.Open(str(staging), 3, False)  # SSFMCreateForWrite
                voice.AudioOutputStream = stream
                voice.Speak(note["transcript"], 0)  # synchronous; only the fixed sample sentence is spoken
                stream.Close()
                with wave.open(str(staging), "rb") as sample:
                    if sample.getnframes() == 0 or sample.getframerate() == 0:
                        raise RuntimeError(f"SAPI produced an empty recording: {target.name}")
                    note["durationSeconds"] = max(1, round(sample.getnframes() / sample.getframerate()))
                staging.replace(target)
            except Exception:
                try:
                    stream.Close()
                except Exception:
                    pass
                staging.unlink(missing_ok=True)
                raise
            note["mimeType"] = "audio/wav"

        (OUTPUT / "sample-voice-notes.json").write_text(json.dumps(NOTES, indent=2) + "\n", encoding="utf-8")
        print(f"Generated {len(NOTES)} spoken WAV samples with matching typed notes in {OUTPUT}.")
    finally:
        pythoncom.CoUninitialize()


if __name__ == "__main__":
    generate()
