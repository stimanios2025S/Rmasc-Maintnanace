"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Thin wrapper over the browser's Web Speech API.
 *
 * WHY THE GUARDS
 * `speechSynthesis` is not universally available (it is absent in some
 * embedded webviews and can throw outright in a locked-down browser), and the
 * clients who rely on it are precisely the ones who cannot fall back to
 * reading the screen. So every call is feature-detected and wrapped: if
 * speech is unavailable the UI hides the audio affordances and *still*
 * renders the instructions as text, rather than presenting a button that
 * silently does nothing.
 *
 * WHY CANCEL-BEFORE-SPEAK
 * `speak()` queues utterances rather than replacing them. Pressing "listen"
 * three times would otherwise read the whole thing three times over, with no
 * way to stop short of a page reload. Each new utterance cancels the last.
 */
export function useSpeech(locale = "fr-FR") {
  const [supported, setSupported] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);

  useEffect(() => {
    setSupported(
      typeof window !== "undefined" &&
        "speechSynthesis" in window &&
        typeof window.SpeechSynthesisUtterance === "function"
    );
  }, []);

  // Never leave the device talking after the component is gone — a client
  // navigating away mid-sentence would otherwise keep hearing the old page.
  useEffect(() => {
    return () => {
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  const stop = useCallback(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    setSpeaking(false);
  }, []);

  const speak = useCallback(
    (text: string) => {
      if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
      if (!text.trim()) return;

      window.speechSynthesis.cancel();

      try {
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = locale;
        utterance.rate = 0.95; // marginally slower than default; this is read to people who need it
        utterance.onend = () => setSpeaking(false);
        utterance.onerror = () => setSpeaking(false);

        utteranceRef.current = utterance;
        setSpeaking(true);
        window.speechSynthesis.speak(utterance);
      } catch {
        // A browser that advertises the API but refuses to speak. The text is
        // already on screen; there is nothing useful to do here.
        setSpeaking(false);
      }
    },
    [locale]
  );

  return { supported, speaking, speak, stop };
}
