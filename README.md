# Cashback manquant

Retrouve les achats faits via **Remises & Réductions** dont le cashback n'a pas été enregistré,
prépare les réclamations dans **Gmail** (en brouillons : rien n'est envoyé sans toi), suit les
réponses de R&R et affiche un bilan de ce que tu as récupéré.

Ce dépôt ne contient que la **dernière version** à installer. L'appli se met ensuite à jour toute
seule.

## Avant d'installer

1. **Une clé de licence** (elle commence par `RR1.`) : demande-la à ZaRoXUltrA.
2. **Ton propre accès Google** (gratuit, 5 minutes) : l'appli t'explique pas à pas comment le
   créer au premier lancement. Il reste à toi : personne d'autre ne peut s'en servir.
3. Un compte **Remises & Réductions** et Windows 10 ou 11.

## Installer

1. Télécharge le fichier `Setup Cashback manquant X.Y.Z.exe` de ce dépôt (bouton *Download raw*).
2. Lance-le. Windows affiche sans doute « Windows a protégé votre ordinateur » : clique sur
   *Informations complémentaires*, puis *Exécuter quand même* (l'appli n'est pas signée par un
   éditeur payant, c'est normal).
3. L'assistant de l'appli te guide : licence, accès Google, connexion à R&R, connexion à Gmail,
   première analyse. Google affiche « Google n'a pas validé cette application » : c'est ton
   propre projet, clique sur *Continuer*.

Tes données (mails, compte R&R) restent **sur ton PC** et passent par **ton** projet Google :
personne d'autre n'y a accès, pas même ZaRoXUltrA.

## Rappel d'activation dans le navigateur (facultatif)

Un bandeau sur les sites partenaires de R&R propose d'activer le cashback en un clic, et insiste
au moment de payer s'il ne l'est pas. Il affiche aussi les taux d'iGraal, TopCashback, eBuyClub,
Widilo et Poulpeo pour le même marchand (en orange quand c'est mieux que R&R), avec un lien vers leur page,
et les codes promo publiés par R&R (un clic pour copier). Attention : un code promo trouvé ailleurs
que sur R&R fait perdre le cashback R&R (conditions d'utilisation de R&R, article 4.1).
À la mise à jour, Tampermonkey demande d'autoriser ces sites : accepte (« Toujours autoriser »).

1. Installe l'extension **Tampermonkey** (Chrome Web Store ou modules Firefox / Edge).
2. Chrome et Edge : *Extensions → Tampermonkey → Détails* → active **« Autoriser les scripts
   utilisateur »**.
3. Ouvre le fichier `rr-cashback.user.js` de ce dépôt en version *Raw* → **Installer**.
4. Ouvre une fois remisesetreductions.fr en étant connecté : la liste des marchands se charge.

## Confidentialité

Cashback manquant fonctionne entièrement sur ton PC. Il lit ton compte Remises & Réductions et
tes mails Gmail (lecture seule, plus création de brouillons : **jamais d'envoi**) uniquement pour
retrouver tes achats sans cashback. Rien n'est envoyé ailleurs : ni à l'auteur, ni à un serveur
tiers. Tes accès (session R&R, identifiants R&R chiffrés par Windows, autorisation Gmail) restent
dans ton dossier `%LOCALAPPDATA%\Cashback manquant`. Pour tout effacer : désinstalle l'appli,
supprime ce dossier et retire l'accès dans ton compte Google (Sécurité → Applications tierces).
