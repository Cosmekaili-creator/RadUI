// SPDX-License-Identifier: AGPL-3.0-or-later
// French dictionary part: conflict (the dialogs shown when the server answered "changed elsewhere" or
// "deleted elsewhere"). Same keys and `{placeholders}` as en.conflict.js.

export default Object.freeze({
  // edit conflict (412 on save)
  'conflict.title': 'Cet élément a été modifié ailleurs',
  'conflict.text': '« {name} » a été modifié sur le serveur après son ouverture (autre appareil ou autre compte). Votre version n’est pas encore enregistrée.',
  'conflict.textUnnamed': 'Cet élément a été modifié sur le serveur après son ouverture (autre appareil ou autre compte). Votre version n’est pas encore enregistrée.',
  'conflict.caption': 'Différences entre votre version et celle du serveur',
  'conflict.col.field': 'Champ',
  'conflict.col.mine': 'Votre version',
  'conflict.col.theirs': 'Sur le serveur',
  'conflict.empty': '(vide)',
  'conflict.both': 'Modifié des deux côtés',
  'conflict.status.identical': "Déjà identique sur le serveur : rien à enregistrer.",
  'conflict.photo.changed': 'modifiée',
  'conflict.photo.unchanged': 'inchangée',
  'conflict.noRows': 'Aucune différence dans les champs que cette application modifie n’a pu être affichée. La version du serveur a changé d’une autre manière.',
  'conflict.help': 'Recharger la leur abandonne vos modifications. Écraser avec la mienne applique vos modifications par-dessus leur version et garde leurs autres modifications. Garder la mienne en copie conserve les deux versions.',

  // fields (row labels)
  'conflict.field.fn': 'Nom affiché',
  'conflict.field.n': 'Nom',
  'conflict.field.nickname': 'Surnom',
  'conflict.field.org': 'Organisation',
  'conflict.field.title': 'Fonction',
  'conflict.field.tel': 'Téléphone',
  'conflict.field.email': 'E-mail',
  'conflict.field.adr': 'Adresse',
  'conflict.field.url': 'Adresse web',
  'conflict.field.bday': 'Anniversaire',
  'conflict.field.anniversary': 'Date anniversaire',
  'conflict.field.note': 'Note',
  'conflict.field.categories': 'Catégories',
  'conflict.field.photo': 'Photo',
  'conflict.field.kind': 'Type',
  'conflict.field.members': 'Membres',

  // buttons
  'conflict.reload': 'Recharger la leur',
  'conflict.overwrite': 'Écraser avec la mienne',
  'conflict.copy': 'Garder la mienne en copie',
  'conflict.cancel': 'Annuler',
  'conflict.overwriteDisabled': 'L’écrasement est impossible : cette application ne peut pas modifier la version du serveur.',
  'conflict.copyDisabled.group': 'Un groupe ne peut pas être gardé en copie.',
  'conflict.copyDisabled.other': 'Garder une copie est impossible pour cet élément.',

  // changes that cannot be applied automatically
  'conflict.unmappable.title': 'Ces modifications ne peuvent pas être appliquées automatiquement :',
  'conflict.unmappable.modify': '{field} : votre modification de « {base} » (devenu « {mine} »)',
  'conflict.unmappable.remove': '{field} : votre suppression de « {base} »',
  'conflict.unmappable.explain': 'L’entrée correspondante n’existe plus dans leur version : ces modifications sont omises si vous écrasez.',
  'conflict.unmappable.confirm': 'Je comprends que ces modifications seront omises.',

  'conflict.nickname.confirm': 'Le serveur ne garde que le premier surnom d’une liste. J’accepte de perdre : {values}.',

  // where mine won without being asked
  'conflict.notes.title': 'Là où votre version l’a emporté :',
  'conflict.note.both-edited': '{field} : vous avez tous deux modifié {parts} ; votre version l’a emporté.',
  'conflict.note.theirs-removed': '{field} : ils l’ont supprimé pendant que vous modifiiez {parts} ; votre version a été conservée.',
  'conflict.note.pref-moved': '{field} : vous avez marqué une autre entrée comme préférée, donc leur marque « préféré » sur « {row} » a été retirée.',
  'conflict.note.generic': '{field} : votre version l’a emporté.',
  'conflict.part.any': 'certaines parties',
  'conflict.part.value': 'la valeur',
  'conflict.part.types': 'les types',
  'conflict.part.name': 'le nom',
  'conflict.part.units': 'les unités',
  'conflict.part.family': 'le nom de famille',
  'conflict.part.given': 'le prénom',
  'conflict.part.additional': 'les noms supplémentaires',
  'conflict.part.prefix': 'le préfixe',
  'conflict.part.suffix': 'le suffixe',

  // progress, outcomes
  'conflict.working': 'En cours…',
  'conflict.again': 'L’élément a encore changé avant que votre choix puisse être enregistré. Examinez les nouvelles différences.',
  'conflict.err.generic': 'L’action n’a pas abouti ({status}). Vérifiez l’élément avant de réessayer.',
  'conflict.cancelled': 'Conflit non résolu : rien n’a été enregistré.',

  // deleted elsewhere
  'conflict.deleted.title': 'Cet élément a été supprimé ailleurs',
  'conflict.deleted.text': '« {name} » a été supprimé sur le serveur après son ouverture. Votre version n’est pas enregistrée.',
  'conflict.deleted.textUnnamed': 'Cet élément a été supprimé sur le serveur après son ouverture. Votre version n’est pas enregistrée.',
  'conflict.deleted.help': 'Garder la mienne en copie crée un nouvel élément avec votre version. Abandonner mes modifications les supprime.',
  'conflict.deleted.discard': 'Abandonner mes modifications',

  // changed elsewhere before a delete
  'conflict.changed.text': '« {name} » a été modifié sur le serveur après son ouverture : il n’a pas été supprimé.',
  'conflict.changed.textUnnamed': 'Cet élément a été modifié sur le serveur après son ouverture : il n’a pas été supprimé.',
  'conflict.changed.help': 'Afficher leur version permet de voir ce qui a changé. Supprimer quand même retire l’élément avec leurs modifications.',
  'conflict.changed.show': 'Afficher leur version',
  'conflict.changed.deleteAnyway': 'Supprimer quand même',

  // événements et tâches (RUN3) : libellés du tableau des différences, opérations non rejouables
  'conflict.field.summary': 'Titre',
  'conflict.field.description': 'Description',
  'conflict.field.location': 'Lieu',
  'conflict.field.start': 'Début',
  'conflict.field.end': 'Fin',
  'conflict.field.due': 'Échéance',
  'conflict.field.rrule': 'Règle de répétition',
  'conflict.field.exdates': 'Occurrences supprimées',
  'conflict.field.overrides': 'Occurrences modifiées',
  'conflict.field.status': 'Statut',
  'conflict.field.transp': 'Affiché comme',
  'conflict.field.alarms': 'Rappels',
  'conflict.field.priority': 'Priorité',
  'conflict.field.percent': 'Avancement',
  'conflict.occurrence': '{field} (occurrence du {when})',
  'conflict.overwriteDisabled.ops': 'L’écrasement est impossible : votre modification ne peut pas être appliquée à leur version (voir la liste ci-dessus).',
  'conflict.unmappable.replay': '{field} : {reason}',
  'conflict.replay.start-mismatch': 'le début de la série a été modifié ailleurs ; les occurrences que vous avez changées ne peuvent pas être reportées',
  'conflict.replay.allday-toggle-with-exceptions': 'leur version contient des occurrences supprimées ou modifiées, qui ne peuvent pas passer de « toute la journée » à une heure précise (ou l’inverse)',
  'conflict.replay.unknown-zone': 'leur version utilise un fuseau horaire que cette application ne connaît pas',
  'conflict.replay.no-master': 'leur version n’a pas d’événement principal',
  'conflict.replay.error': 'cette modification ne s’applique plus à leur version',
});
