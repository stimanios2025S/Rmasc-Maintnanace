import { redirect } from "next/navigation";

/**
 * Alias de la rubrique « Audits de reprise ».
 *
 * L'écran vit sous `/administration/ascenseurs`, où le middleware applique la
 * restriction aux rôles de gestion et où le registre des reprises est servi.
 * Cette adresse est conservée comme porte d'entrée courte depuis les liens
 * métier ; elle redirige plutôt que de dupliquer l'écran, pour qu'il n'existe
 * qu'une seule implémentation du parcours d'audit.
 */
export default function AscenseursAuditsAliasPage() {
  redirect("/administration/ascenseurs");
}
