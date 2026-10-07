# Third-Party Notices

## SRD 5.1

This work includes material taken from the System Reference Document 5.1 ("SRD 5.1") by Wizards of the Coast LLC and available at https://dnd.wizards.com/resources/systems-reference-document. The SRD 5.1 is licensed under the Creative Commons Attribution 4.0 International License available at https://creativecommons.org/licenses/by/4.0/legalcode.

This project includes a narrow, adapted selection of names and game mechanics from the **System Reference Document 5.1 (SRD 5.1)** by Wizards of the Coast LLC:

https://media.dndbeyond.com/compendium-images/srd/5.1/SRD_CC_v5.1.pdf

The SRD 5.1 material is licensed under the **Creative Commons Attribution 4.0 International License (CC BY 4.0)**:

https://creativecommons.org/licenses/by/4.0/legalcode

Velvet modified the selected material by condensing descriptions, adapting mechanics to bounded catalog schemas, selecting the prayer-book variant for the aggregate Acolyte equipment entry, and omitting unsupported rules and prose. The Training Dummy is an original Velvet test fixture and is not SRD material.

The `srd-5.1:starter@1.0.3+013693787a86` publication additionally selects bounded, executable basic attacks from the SRD 5.1 Bandit (PDF p. 117), Goblin (PDF p. 143), and Wolf (PDF p. 159) entries. It records only the verified AC, HP, speed, proficiency bonus, one attack bonus, damage dice/modifier, and damage type needed for those attacks. Traits, alternate attacks, saving-throw riders, and all other statblock material are omitted and are not executable.

The separate `srd-5.1:starter@1.1.0+2b1f05336aac` publication preserves that 1.0.3 publication unchanged and adds only the SRD Fighter table and class features needed for the exact Human/Acolyte/Fighter path: level 1 maximum d10 hit points, level 2 fixed hit-point increase (6 before Constitution modifier), proficiency bonus +2, Second Wind, and Action Surge (SRD 5.1 PDF pp. 25-26). That immutable publication remains historical; the current starter carries forward its bounded Fighter progression. Fighter level 3 Martial Archetype (PDF p. 25) was explicitly unsupported in that publication.

The current `srd-5.1:starter@1.7.0+a870b31918ec` publication adds 23 mundane weapon profiles, half plate, six bounded equipment packs, nine spellcasting foci, three holy-symbol variants (SRD PDF pp. 63–70), four composite subrace-derived ancestry choices (pp. 4–6), and inert references for Forbiddance (p. 146) and Wall of Thorns (p. 191). It corrects Greatsword damage to 2d6 and removes Ring Mail's incorrect Strength requirement. Pack contents, focus component substitution, subrace choice-dependent features and the two new spells' effects are not automated. Fractional-gold weapon prices are recorded in descriptions and represented as zero under the existing integer-gold schema. Catalog inclusion does not establish executable support for every rule, feature or interaction. Earlier publications remain immutable. The [SRD coverage guide](docs/srd-5.1-coverage.md) and [versioned coverage inventory](docs/srd-5.1-coverage.v1.json) record current executable behavior and its limits.

The source audit for this tranche found an inherited provenance backlog: the existing feat builder includes 38 feats beyond the SRD's Grappler, and some earlier spell entries are absent from the SRD 5.1 PDF. Their existing SRD tags are not verified source attribution. See the [hydration review](docs/srd-5.1-hydration.md) for the findings; this tranche's additions were checked directly against the official PDF.
