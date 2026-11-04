/**
 * Fond animé commun aux interfaces de travail.
 *
 * TROIS COUCHES, ET POURQUOI ELLES SONT FIXES
 *  - une couleur de repli, pour que l'écran reste lisible si le GIF manque ;
 *  - le GIF, en `cover`, centré ;
 *  - un voile sombre translucide qui garantit le contraste des cartes et des
 *    tableaux posés dessus.
 *
 * Les trois sont `fixed` et `inset-0` : le défilement de la page ne les étire
 * pas et ne les fait pas glisser. Le contenu est rendu au-dessus avec un
 * `relative z-10` par les layouts.
 *
 * POURQUOI LE VOILE N'EST PAS PLUS OPAQUE
 * Un voile à 85 % rendait le GIF indiscernable — le fond existait, mais on ne
 * voyait qu'un aplat gris. Le voile est clair en thème clair (pour garder les
 * titres sombres lisibles hors des cartes) et sombre en thème sombre ; dans les
 * deux cas, il laisse l'image visible.
 */
export function AppBackground() {
  return (
    <>
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 z-0 bg-slate-900"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 z-0"
        style={{
          backgroundImage: "url('/bg-animated.gif')",
          backgroundSize: "cover",
          backgroundPosition: "center",
          backgroundRepeat: "no-repeat",
        }}
      />
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 z-0 bg-white/60 backdrop-blur-[2px] dark:bg-slate-950/70"
      />
    </>
  );
}
