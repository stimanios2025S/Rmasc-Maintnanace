"use client";

import { HelpCircle } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { GLOSSARY, type GlossaryKey } from "@/lib/ui/glossary";
import { cn } from "@/lib/utils";

/**
 * Une infobulle métier, accessible au survol, au clavier et au doigt.
 *
 * POURQUOI PAS UN `title`
 * L'attribut `title` n'apparaît ni au clavier ni sur un écran tactile, met une
 * seconde à s'ouvrir et n'est pas lu de façon fiable par les lecteurs d'écran.
 * Les notions qui décident d'un délai contractuel ou d'une alerte méritent mieux
 * qu'une bulle native que la moitié des utilisateurs ne verra jamais.
 *
 * TROIS ENTRÉES, UNE SORTIE
 * Survol pour la souris, focus pour le clavier, appui pour le téléphone. Échap
 * ferme, un clic à l'extérieur aussi. Le bouton porte `aria-expanded` et le
 * texte est relié par `aria-describedby`, donc l'aide est annoncée comme le
 * reste du contenu.
 */
export function InfoHint({
  term,
  className,
  side = "center",
}: {
  /** La clé du lexique — jamais un texte libre, pour que l'aide ne diverge pas. */
  term: GlossaryKey;
  className?: string;
  /** Côté d'ancrage, quand la bulle sortirait de l'écran. */
  side?: "center" | "left";
}) {
  const entry = GLOSSARY[term];
  const [open, setOpen] = useState(false);
  const id = useId();
  const wrapper = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    function onPointerDown(event: PointerEvent) {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
    }

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  return (
    <span ref={wrapper} className={cn("relative inline-flex align-middle", className)}>
      <button
        type="button"
        aria-label={`Aide — ${entry.term}`}
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={(event) => {
          // Sur téléphone, le clic est la seule entrée. Il ouvre sans basculer :
          // à la souris, le survol a déjà ouvert la bulle, et un clic qui la
          // referme immédiatement donnerait l'impression d'un bouton cassé.
          // Échap, un clic ailleurs ou la sortie du survol la referment.
          event.preventDefault();
          setOpen(true);
        }}
        className="inline-flex h-5 w-5 items-center justify-center rounded-full text-gray-400 transition-colors hover:text-gray-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:hover:text-gray-200"
      >
        <HelpCircle className="h-4 w-4" aria-hidden="true" />
      </button>

      {open && (
        <span
          role="tooltip"
          id={id}
          className={cn(
            "absolute top-full z-[900] mt-2 w-64 max-w-[80vw] rounded-xl border border-gray-200 bg-white p-3 text-left shadow-xl dark:border-gray-700 dark:bg-gray-800",
            side === "left" ? "left-0" : "left-1/2 -translate-x-1/2"
          )}
        >
          <span className="block text-xs font-semibold text-gray-900 dark:text-white">
            {entry.term}
          </span>
          <span className="mt-1 block text-xs leading-relaxed text-gray-600 dark:text-gray-300">
            {entry.long ?? entry.short}
          </span>
        </span>
      )}
    </span>
  );
}
