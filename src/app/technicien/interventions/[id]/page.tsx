import { redirect } from "next/navigation";

/**
 * Le lien profond d'une intervention, côté terrain.
 *
 * Le portail technicien est un écran unique qui choisit sa mission à partir de
 * `?mission=<id>` ; il n'a pas de route par intervention. Cette page existe
 * pour que la notification puisse désigner le bon avec une adresse stable,
 * lisible et partageable, sans dupliquer l'écran ni changer le paramètre que
 * le portail lit déjà.
 *
 * La redirection conserve l'identifiant encodé : un id qui contiendrait un
 * caractère réservé ne doit pas casser l'URL du portail.
 */
export default function TechnicianInterventionPage({
  params,
}: {
  params: { id: string };
}) {
  redirect(`/technicien?mission=${encodeURIComponent(params.id)}`);
}
