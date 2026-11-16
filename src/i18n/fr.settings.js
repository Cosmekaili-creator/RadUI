// SPDX-License-Identifier: AGPL-3.0-or-later
// Dictionnaire français, partie « réglages » : l'écran Réglages (`#/settings`). Mêmes clés et mêmes
// `{paramètres}` que en.settings.js. Le lot B3b y ajoute les clés des préférences d'agenda (settings.cal.*).

export default Object.freeze({
  'settings.title': 'Réglages',
  'settings.status': 'Connecté en tant que {login}. Vos préférences sont conservées dans ce navigateur, séparément pour chaque compte.',
  'settings.status.admin': 'Connecté en tant que {login} (administrateur). Vos préférences sont conservées dans ce navigateur, séparément pour chaque compte.',

  // account
  'settings.account.title': 'Votre compte',
  'settings.account.login': 'Identifiant',
  'settings.account.name': 'Nom affiché',
  'settings.account.type': 'Type',
  'settings.account.admin': 'Administrateur',
  'settings.account.loading': 'Chargement des informations de votre compte…',
  'settings.account.unavailable': 'Les informations de votre compte sont indisponibles : le service de comptes n\'a pas répondu.',

  // own password
  'settings.password.title': 'Mot de passe',
  'settings.password.intro': 'Choisissez un nouveau mot de passe pour votre propre compte. Vous restez connecté sur cet appareil.',
  'settings.password.new': 'Nouveau mot de passe',
  'settings.password.repeat': 'Répétez le nouveau mot de passe',
  'settings.password.hint': '72 octets au maximum (la plupart des caractères comptent pour un ; les lettres accentuées et les symboles comptent pour deux ou plus).',
  'settings.password.save': 'Changer le mot de passe',
  'settings.password.saving': 'Changement du mot de passe…',
  'settings.password.generate': 'Générer un mot de passe à la place',
  'settings.password.adminOnly': 'Demandez à un administrateur de réinitialiser votre mot de passe.',
  'settings.password.err.required': 'Saisissez le nouveau mot de passe.',
  'settings.password.err.repeatRequired': 'Saisissez le nouveau mot de passe une seconde fois.',
  'settings.password.err.mismatch': 'Les deux mots de passe ne sont pas identiques.',
  'settings.password.err.tooLong': 'Ce mot de passe dépasse 72 octets. Choisissez-en un plus court.',
  'settings.password.err.rejected': 'Le serveur n\'a pas accepté ce mot de passe. Rien n\'a été modifié.',
  'settings.password.err.forbidden': 'Vous n\'êtes pas autorisé à changer ce mot de passe.',
  'settings.password.err.rateLimited': 'Trop de tentatives. Patientez un instant, puis réessayez.',
  'settings.password.err.network': 'Le serveur est injoignable. Rien n\'a été modifié.',
  'settings.password.err.generic': 'Le mot de passe n\'a pas pu être changé. Rien n\'a été modifié.',
  'settings.password.done': 'Votre mot de passe a été changé. Cet appareil vous garde connecté avec le nouveau.',
  'settings.password.pending': 'Enregistré ; le serveur est encore en train de l\'appliquer. Cet appareil vous garde connecté avec le nouveau mot de passe.',
  'settings.password.once.title': 'Votre nouveau mot de passe',
  'settings.password.once.text': 'Ce mot de passe n\'est affiché qu\'une seule fois. Enregistrez-le maintenant dans un gestionnaire de mots de passe : il ne pourra plus être affiché.',
  'settings.password.once.label': 'Nouveau mot de passe',
  'settings.password.once.ack': 'J\'ai enregistré le nouveau mot de passe',
  'settings.password.once.copy': 'Copier le mot de passe',
  'settings.password.once.copied': 'Copié.',
  'settings.password.once.copyFailed': 'Le mot de passe n\'a pas pu être copié. Sélectionnez-le et copiez-le à la main.',
  'settings.password.once.confirm': 'Terminé',

  // language
  'settings.language.title': 'Langue',
  'settings.language.en': 'English',
  'settings.language.fr': 'Français',
  'settings.language.saved': 'Langue modifiée.',

  // about
  'settings.about.title': 'À propos',
  'settings.about.app': 'Application',
  'settings.about.appName': 'RadUI',
  'settings.about.version': 'Version',
  'settings.about.versionLoading': 'Chargement…',
  'settings.about.versionDev': 'version de développement',
  'settings.about.licence': 'Licence',
  'settings.about.licenceName': 'AGPL-3.0-or-later',
  'settings.about.source': 'Code source',
  'settings.about.sourceNone': "Le code source de ce service est disponible auprès de son administrateur.",
  'settings.about.sourceIntro': 'Le code source complet de cette version est disponible à l\'adresse suivante :',

  // this device
  'settings.device.title': 'Cet appareil',
  'settings.device.text': 'Se déconnecter et oublier cet appareil supprime de ce navigateur votre connexion et vos préférences enregistrées pour ce compte. Rien ne change sur le serveur.',
  'settings.device.forget': 'Se déconnecter et oublier cet appareil',
  'settings.device.diagnostics': 'Ouvrir le diagnostic',

  // préférences du calendrier (WP B3b ; views/settings/calendar.js)
  'settings.cal.title': 'Calendrier',
  'settings.cal.explain': 'Ces choix restent dans ce navigateur, séparément pour chaque compte. Le fuseau d’affichage ne change que la façon de dessiner les heures : les événements gardent leur propre fuseau et rien n’est écrit sur le serveur.',
  'settings.cal.tz': 'Fuseau horaire d’affichage',
  'settings.cal.tzHint': 'Les heures du calendrier sont affichées dans ce fuseau.',
  'settings.cal.tzLoading': 'Chargement des fuseaux horaires…',
  'settings.cal.tzFailed': 'La liste des fuseaux horaires n’a pas pu être chargée.',
  'settings.cal.firstWeekday': 'Premier jour de la semaine',
  'settings.cal.firstWeekday.auto': 'Selon la langue',
  'settings.cal.clock': 'Horloge',
  'settings.cal.clock.auto': 'Selon la langue',
  'settings.cal.clock.24': '24 heures',
  'settings.cal.clock.12': '12 heures (AM/PM)',
  'settings.cal.birthdays': 'Afficher les anniversaires',
  'settings.cal.birthdaysHint': 'Un calendrier en lecture seule construit à partir des dates de naissance de vos carnets d’adresses.',
  'settings.cal.hideDup': 'Masquer les anniversaires déjà présents dans un calendrier',
  'settings.cal.hideDupHint': 'Ignore un anniversaire lorsqu’un événement annuel sur toute la journée porte le même nom et la même date.',
  'settings.cal.saved': '{what} : enregistré sur cet appareil.',
});
