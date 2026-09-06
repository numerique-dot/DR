# D.R. RDV — Plan d'expérience utilisateur

Vision : un guichet unique, en français, chinois et anglais, où l'on prend rendez-vous
avec un professionnel et où l'on comprend chaque document reçu. Le style reste celui de
l'administration française : sobre, lisible, sans surprise.

Trois principes guident chaque écran :

1. **Zéro ambiguïté.** À tout moment l'usager sait où il en est, ce qui va se passer et
   comment revenir en arrière.
2. **La langue n'est jamais un obstacle.** Chaque texte saisi par l'autre partie est lu
   dans la langue du lecteur ; l'original reste accessible d'un clic.
3. **Confiance visible.** Statuts, horodatages, confirmations écrites, mentions légales
   claires : l'usager voit la preuve, pas seulement la promesse.

---

## 1. Parcours « prendre rendez-vous » (usager)

| Étape | Aujourd'hui | Cible |
|---|---|---|
| Trouver | catalogue filtrable par ville et catégorie | recherche plein texte, tri « au plus tôt disponible », distance depuis une adresse |
| Choisir | fiche commerçant + créneaux | fiche enrichie : photos, langues parlées, durée, tarif indicatif, avis vérifiés (après RDV honoré) |
| Réserver | 3 clics, note traduite | récapitulatif avant validation, choix du canal de rappel, ajout au calendrier (.ics) |
| Attendre | courriel de confirmation | rappel J-1 (courriel, SMS en option), plan d'accès, « quoi apporter » rédigé par le commerçant et traduit |
| Vivre le RDV | — | fil de messages avec le commerçant, traduction bidirectionnelle (existe) |
| Après | annulation | reprogrammation en un clic, avis, historique exportable |

Détails qui font la différence :

- **Créneaux « au plus tôt »** en haut de chaque fiche : le premier créneau libre est
  l'information la plus demandée.
- **Reprogrammer sans annuler** : un seul geste, le créneau initial est libéré
  atomiquement (même mécanisme que l'index unique actuel).
- **Liste d'attente** : si le créneau souhaité est pris, l'usager est prévenu dès qu'il
  se libère.
- **Cas médical** : la note de réservation propose des cases à cocher pré-traduites
  (« première consultation », « renouvellement », « urgence ressentie ») plutôt qu'un
  texte libre, pour limiter la saisie de données de santé ; rappel qu'aucune donnée
  médicale ne doit être écrite tant que l'hébergement HDS n'est pas contractualisé.
- **Accessibilité RGAA** : contraste AA, navigation clavier complète, lecteurs d'écran
  testés sur le tunnel de réservation, taille de police ajustable.

## 2. Parcours « traduire un document » (studio)

| Étape | Aujourd'hui | Cible |
|---|---|---|
| Déposer | fichier ou texte | photo depuis le téléphone (caméra), plusieurs pages, détection automatique de la langue source |
| Comprendre | traduction fidèle (gratuit) | mise en regard **original / traduction** paragraphe par paragraphe, surlignage synchronisé |
| Agir (membre) | cautions, glossaire, questions, suivi | **dates et montants extraits** et affichés en tête ; « ce que l'on attend de vous » ; brouillon de réponse dans la langue du destinataire |
| Conserver | historique optionnel | classeur personnel par dossier (logement, santé, emploi, préfecture), partage d'un lien temporaire au commerçant |
| Aller au RDV | — | « prendre rendez-vous avec quelqu'un qui peut m'aider » : passerelle directe du document vers le catalogue filtré par catégorie |

Détails :

- **Glossaire vivant** : les termes administratifs (attestation, quittance, devis,
  ordonnance…) sont expliqués une fois et retrouvés dans tout le site.
- **Niveau de langue** : bouton « plus simple » qui reformule la traduction en langage
  clair (norme FALC), utile aux lecteurs peu à l'aise à l'écrit.
- **Confidentialité explicite** : avant chaque envoi, une phrase indique ce qui est
  transmis à l'IA, combien de temps c'est conservé, et comment l'effacer.

## 3. Parcours commerçant (côté professionnel)

- **Onboarding en 10 minutes** : fiche, premier service, première semaine de créneaux
  générée depuis un **horaire hebdomadaire récurrent** (priorité n° 1 des retours).
- **Agenda visuel** : vue semaine avec glisser-déposer, fermetures exceptionnelles,
  pause déjeuner.
- **Fiche multilingue automatique** : le commerçant écrit en français, la fiche est
  affichée en chinois et en anglais (cache de traduction existant) ; il peut corriger.
- **Boîte de réception unifiée** : réservations, messages, annulations, avec le
  récapitulatif différé actuel ; traduction des messages entrants déjà en place.
- **Indicateurs simples** : taux de présence, délai moyen de réservation, créneaux
  jamais pris → suggestions d'horaires.
- **Confiance** : badge « fiche vérifiée » après validation par la modération, langues
  parlées déclarées, délai de réponse moyen affiché.

## 4. Confiance, sécurité, légal (rôle de la plateforme)

- **Preuves écrites** à chaque étape : confirmation, modification, annulation, chacune
  horodatée dans le fuseau Europe/Paris et dans la langue du destinataire.
- **Politique d'annulation** visible avant de réserver, fixée par le commerçant dans des
  limites définies par la plateforme.
- **Modération** : file de validation des fiches (existe), signalement d'un commerçant ou
  d'un message, suspension motivée.
- **Données** : minimisation (pas de texte médical libre), export et suppression de
  compte en libre-service, registre des traitements, DPO joignable, mentions légales
  complétées avec les valeurs réelles (SIRET, éditeur, hébergeur).
- **Sécurité** : déjà en place — mots de passe scrypt, sessions hachées, CSP stricte,
  limitation de débit, vérification d'origine. À ajouter : double authentification pour
  les commerçants et la modération, journal d'accès consultable par l'usager.

## 5. Modèle économique aligné sur l'expérience

- Gratuit pour l'usager : réserver, écrire, lire une traduction fidèle.
- Membre 9 €/mois : cautions, glossaire, extraction de dates et montants, brouillons de
  réponse, classeur, langage clair.
- Commerçant : gratuit tant que la fiche est simple ; offre « Pro » pour l'agenda
  récurrent avancé, plusieurs collaborateurs, statistiques, rappel SMS.
- Aucune publicité, aucun tri payant du catalogue : l'ordre reste « au plus tôt » ou
  « au plus proche ».

## 6. Feuille de route proposée

| Vague | Contenu | Effort |
|---|---|---|
| 1 — fondations | horaire hebdomadaire récurrent, reprogrammation, .ics, rappel J-1, photos de fiche, compte en libre-service (mot de passe, suppression) | 3 semaines |
| 2 — compréhension | vue original/traduction en regard, dates & montants extraits, langage clair, photo caméra | 3 semaines |
| 3 — confiance | avis vérifiés, liste d'attente, badge fiche vérifiée, politique d'annulation, signalement | 3 semaines |
| 4 — professionnels | agenda visuel, indicateurs, collaborateurs, offre Pro, SMS | 4 semaines |

Chaque vague se termine par un test avec cinq usagers réels (dont trois non
francophones) et cinq commerçants, tunnel chronométré et erreurs relevées.

## 7. Mesures de réussite

- Réserver un créneau depuis la page d'accueil : moins de 90 secondes, 3 écrans.
- Comprendre un document : traduction affichée en moins de 20 secondes.
- Taux de rendez-vous honorés : supérieur à 90 % grâce aux rappels.
- Réponse d'un commerçant à un message : médiane sous 24 heures.
- Zéro question de support portant sur « où en est ma réservation ».
