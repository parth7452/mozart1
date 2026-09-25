# Scanned office papers: does the reader mistake them for money documents?

*One-time check, 2026-09-25. Nothing in the product changed because of it.
No page, image or recording from the dataset is kept in this repository:
RVL-CDIP's license is the Legacy Tobacco Documents Library's own, not an open
one. This page keeps only row numbers, a hash of each row's image, and what
the classifier answered.*

## In plain language

We showed the document-type reader 160 scanned office papers it had never
seen. They were 10 each of 16 kinds: letters, memos, forms, emails, budgets,
invoices, specifications, résumés and so on. Most are from the 1980s and
1990s and are hard to read.

- **None of the 160 would have opened a case by itself.** Only a deduction
  notice or a payment advice can open one, and only at 0.95 confidence or
  above (ADR 0044). Nothing was read as a deduction notice. Two pages were
  read as payment advices, at 0.92 and 0.85, so both would have waited for a
  person. Both really are payment advices by our definition: a Philip Morris
  check stub listing the invoice it pays (row 117, which the dataset calls an
  invoice) and a Tobacco Institute check with its remittance stub (row 105,
  which the dataset calls a budget).
- **Invoices: 6 of 10 read as invoices.** Of the other four, two are right by
  our definitions: the check stub above, and a shipping confirmation read as
  a ship notice (row 113). Two are genuinely ambiguous: a form headed
  "Purchase Order Invoice No." read as a purchase order (row 111), and a
  law firm's "First Notice: Patent Tax Payment Due" read as correspondence
  (row 116).
- **The weakness it found: supporting documents get the wrong label.** Five
  of the ten product specifications were read as price agreements (0.75–0.85).
  They carry an effective date and "supersedes", but no prices. Three budgets
  were read as promotion or price agreements. None of these types opens a
  case, so the cost is a mislabelled attachment, not a false case. Telling
  the classifier that an agreement names a price is a later change, and it
  would need the whole corpus re-asked.

## Re-run after the agreement wording changed (2026-09-25)

The classifier was then told that an agreement must fix a price, that an
effective date or "supersedes" does not make one, and that a media buy plan
or marketing budget is not a promotion agreement. Sixty of the rows were asked
again, six classes of ten, for $0.18. The 77 documents of the recorded corpus
were re-asked too ($0.39), and every one still reads as its expected type.

| Rows | Before | After |
| --- | --- | --- |
| Specification (70–79) | 5 `price_agreement`, 1 `routing_guide`, 4 `other` | 2 `price_agreement` (73, 77), 8 `other` |
| Budget (100–109) | 2 `promo_agreement`, 1 `price_agreement`, 1 `remittance_advice`, 1 `correspondence`, 5 `other` | unchanged |
| Invoice (110–119) | 6 `invoice` | 7 `invoice`: row 111, "Purchase Order Invoice", now reads as an invoice |
| Advertisement (40–49) | 4 `correspondence`, 6 `other` | 10 `other` |
| Form (10–19), presentation (120–129) | | same types; confidences moved |

So the wording fixed three of the five specifications, and did nothing for the
budgets: the media buy schedule (101) and the two other budgets still read as
agreements. Still none of the 60 was read as a deduction notice or a payment
advice at or above the 0.95 floor.

## What was sent, and how that differs from production

- **Dataset.** [`nielsr/rvl_cdip_10_examples_per_class`](https://huggingface.co/datasets/nielsr/rvl_cdip_10_examples_per_class),
  revision `94115dbd325e701c0a95abf292e0d119a0c83a57`, the `test` split: 160
  rows, ten per class, drawn from [RVL-CDIP](https://www.cs.cmu.edu/~aharley/rvl-cdip/)
  (Harley et al., ICDAR 2015). The full dataset's own viewer is disabled, and
  this is a published sample of it.
- **What the reader saw.** Each row's TIFF (about 778 × 1000, grayscale),
  converted to PNG and put through `acceptUpload`, as an upload is. Each was
  sent to `ClaudeClassifier` as it runs in production: `claude-haiku-4-5`,
  temperature 0, the current prompt. The filename was `page-NNN.png`, because
  the classifier is shown the filename and the class must not be in it.
- **The difference.** Production also gives the classifier the OCR text of
  an image. This environment has no Reducto key, so these pages were read from
  the image alone, which is harder than production.
- **Cost.** $0.4542 for 160 pages.

RVL-CDIP has no remittance class and no deduction notices. So this check
answers one question, whether ordinary office paper is mistaken for money
documents, and says nothing about how well real deduction paperwork is read.

## Every answer, by the dataset's label

Columns are our types; `·` is none. Every row sums to ten.

| RVL-CDIP says | `invoice` | `remittance_advice` | `po` | `asn` | `price_agreement` | `promo_agreement` | `routing_guide` | `correspondence` | `other` |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| invoice | 6 | 1 | 1 | 1 | · | · | · | 1 | · |
| budget | · | 1 | · | · | 1 | 2 | · | 1 | 5 |
| specification | · | · | · | · | 5 | · | 1 | · | 4 |
| form | · | · | · | · | · | · | · | 3 | 7 |
| letter | · | · | · | · | · | · | · | 9 | 1 |
| memo | · | · | · | · | · | · | · | 7 | 3 |
| email | · | · | · | · | · | · | · | 9 | 1 |
| questionnaire | · | · | · | · | · | · | · | 1 | 9 |
| news article | · | · | · | · | · | · | · | 7 | 3 |
| advertisement | · | · | · | · | · | · | · | 4 | 6 |
| presentation | · | · | · | · | · | · | 1 | 4 | 5 |
| scientific report | · | · | · | · | · | · | · | 2 | 8 |
| scientific publication | · | · | · | · | · | · | · | · | 10 |
| handwritten | · | · | · | · | · | · | · | 5 | 5 |
| file folder | · | · | · | · | · | · | · | · | 10 |
| resume | · | · | · | · | · | · | · | · | 10 |

Confidence across all 160: 0.30 × 4, 0.35 × 1, 0.45 × 8, 0.65 × 2, 0.75 × 12, 0.85 × 36, 0.92 × 6, 0.95 × 89, 0.98 × 1, 0.99 × 1.
91 of 160 were at or above the 0.95 floor. Of those, none was a
deduction notice or a payment advice.

<details>
<summary>All 160 rows: row, the dataset's label, our answer, confidence, and the first 16 hex digits of the SHA-256 of the row's original TIFF bytes</summary>

| Row | Dataset label | Our answer | Confidence | Image hash |
| ---: | --- | --- | ---: | --- |
| 0 | letter | `correspondence` | 0.95 | `ff0be912c9537151` |
| 1 | letter | `correspondence` | 0.95 | `880efa5ea1aff5f3` |
| 2 | letter | `other` | 0.95 | `36c6a3b7f7b9837f` |
| 3 | letter | `correspondence` | 0.95 | `8a25f570049de19a` |
| 4 | letter | `correspondence` | 0.95 | `305d20e78f645b19` |
| 5 | letter | `correspondence` | 0.95 | `05e2ce8762542bb5` |
| 6 | letter | `correspondence` | 0.95 | `43a89bc653d9e25c` |
| 7 | letter | `correspondence` | 0.95 | `52735b245adf2e96` |
| 8 | letter | `correspondence` | 0.95 | `731c3b54f259fe54` |
| 9 | letter | `correspondence` | 0.92 | `1afce96adb176417` |
| 10 | form | `correspondence` | 0.95 | `a8bef9c9089fde66` |
| 11 | form | `other` | 0.85 | `4714c033b23760a7` |
| 12 | form | `correspondence` | 0.75 | `737b0c52ed116d0a` |
| 13 | form | `other` | 0.95 | `7a97a6e4f8981f3d` |
| 14 | form | `other` | 0.92 | `f7e36bc651c9e81b` |
| 15 | form | `other` | 0.85 | `e3441ed3bd4810e1` |
| 16 | form | `other` | 0.95 | `f1fb4e60e345d5cc` |
| 17 | form | `other` | 0.95 | `fa52726102554a2b` |
| 18 | form | `correspondence` | 0.92 | `dcdcd5ce866f3bd6` |
| 19 | form | `other` | 0.95 | `b2f9dfafc85117c3` |
| 20 | email | `correspondence` | 0.95 | `27e0aef566b02436` |
| 21 | email | `correspondence` | 0.85 | `b364c386bb4f6770` |
| 22 | email | `correspondence` | 0.95 | `25e9939daa01acbb` |
| 23 | email | `correspondence` | 0.95 | `c375b6f4b9123414` |
| 24 | email | `other` | 0.95 | `09f89e302350e81a` |
| 25 | email | `correspondence` | 0.95 | `6fcfc031d53fc24c` |
| 26 | email | `correspondence` | 0.95 | `b8c17b1628b684db` |
| 27 | email | `correspondence` | 0.95 | `05e77c6cec5a570b` |
| 28 | email | `correspondence` | 0.95 | `7d90acb61cfd6cb7` |
| 29 | email | `correspondence` | 0.95 | `425f0d9d6e96bf5f` |
| 30 | handwritten | `other` | 0.95 | `5a063177facb5d75` |
| 31 | handwritten | `correspondence` | 0.95 | `e9f9e3b4a2f1cb44` |
| 32 | handwritten | `other` | 0.85 | `d50d05cd52afa5d7` |
| 33 | handwritten | `other` | 0.85 | `586334ab0f379721` |
| 34 | handwritten | `correspondence` | 0.75 | `19f5092031c55949` |
| 35 | handwritten | `other` | 0.45 | `a5b981d9e18daaa1` |
| 36 | handwritten | `other` | 0.95 | `bc0b76572ee493c0` |
| 37 | handwritten | `correspondence` | 0.95 | `245a1b706184f288` |
| 38 | handwritten | `correspondence` | 0.85 | `37425c750dc0ea42` |
| 39 | handwritten | `correspondence` | 0.95 | `b5e518e4021f3eda` |
| 40 | advertisement | `other` | 0.45 | `f198ab64e385db2d` |
| 41 | advertisement | `other` | 0.85 | `37880b840af649f7` |
| 42 | advertisement | `other` | 0.85 | `f2db059a82e3c5de` |
| 43 | advertisement | `correspondence` | 0.45 | `c8fe28fd94334cd8` |
| 44 | advertisement | `correspondence` | 0.75 | `a7149f7248bd8a06` |
| 45 | advertisement | `other` | 0.95 | `2a019ff265e22cfd` |
| 46 | advertisement | `other` | 0.95 | `737e55f7b2158a3b` |
| 47 | advertisement | `correspondence` | 0.45 | `5b2ac90a819c555d` |
| 48 | advertisement | `correspondence` | 0.75 | `6ef549de358fb824` |
| 49 | advertisement | `other` | 0.95 | `b822df23594321b0` |
| 50 | scientific report | `other` | 0.95 | `e26a0f42f12b4c2b` |
| 51 | scientific report | `correspondence` | 0.75 | `756d8b4c9ee9516a` |
| 52 | scientific report | `other` | 0.95 | `94668d6fc895588f` |
| 53 | scientific report | `other` | 0.95 | `e63b140f520e0bcf` |
| 54 | scientific report | `other` | 0.95 | `36a5459cc320e87b` |
| 55 | scientific report | `other` | 0.95 | `90bd41dc00b6e761` |
| 56 | scientific report | `other` | 0.85 | `86226af48ca28df1` |
| 57 | scientific report | `correspondence` | 0.85 | `98cf2416f325cce5` |
| 58 | scientific report | `other` | 0.95 | `e397827bf61d943e` |
| 59 | scientific report | `other` | 0.85 | `b60089dcafb588ea` |
| 60 | scientific publication | `other` | 0.95 | `bb5878215b09aecc` |
| 61 | scientific publication | `other` | 0.95 | `adc54b38437dafb4` |
| 62 | scientific publication | `other` | 0.98 | `90aad2cb65b7ce48` |
| 63 | scientific publication | `other` | 0.95 | `6b252514cab32f74` |
| 64 | scientific publication | `other` | 0.95 | `60f65b322a41a722` |
| 65 | scientific publication | `other` | 0.85 | `f924c696e5f4bae1` |
| 66 | scientific publication | `other` | 0.95 | `4d80d52685dbddc2` |
| 67 | scientific publication | `other` | 0.95 | `6a02c7215717df2d` |
| 68 | scientific publication | `other` | 0.95 | `603c372d87e7cd91` |
| 69 | scientific publication | `other` | 0.95 | `9dd7b2b76dc0caa5` |
| 70 | specification | `other` | 0.95 | `475aaba155bccb64` |
| 71 | specification | `routing_guide` | 0.75 | `68c14fd4f29d8683` |
| 72 | specification | `price_agreement` | 0.85 | `c5c3a6bd2c006241` |
| 73 | specification | `price_agreement` | 0.85 | `f4e4ae73be03b8f9` |
| 74 | specification | `other` | 0.85 | `51f873625d552dbe` |
| 75 | specification | `other` | 0.95 | `11d133171e09e863` |
| 76 | specification | `other` | 0.95 | `b557c6142e67d161` |
| 77 | specification | `price_agreement` | 0.75 | `4246802fb49d7af0` |
| 78 | specification | `price_agreement` | 0.85 | `a5718e7385cd4d2f` |
| 79 | specification | `price_agreement` | 0.85 | `1086ca4a8b0bbd15` |
| 80 | file folder | `other` | 0.30 | `9f4fcf3efe4a5ce4` |
| 81 | file folder | `other` | 0.30 | `8d8405b4e52699df` |
| 82 | file folder | `other` | 0.35 | `0909a39d77691156` |
| 83 | file folder | `other` | 0.45 | `d1da4044b518e284` |
| 84 | file folder | `other` | 0.85 | `e2318c5fabefa741` |
| 85 | file folder | `other` | 0.85 | `2bfb6f9fb01e53d1` |
| 86 | file folder | `other` | 0.30 | `e730fbc2a86ae122` |
| 87 | file folder | `other` | 0.65 | `2e9b9eb571be040b` |
| 88 | file folder | `other` | 0.45 | `c911c869d0e05660` |
| 89 | file folder | `other` | 0.95 | `bc9464caae52ccd1` |
| 90 | news article | `correspondence` | 0.75 | `df5a44a6b9bb3594` |
| 91 | news article | `correspondence` | 0.85 | `0d54786024d105fc` |
| 92 | news article | `correspondence` | 0.85 | `da239c64d9b2293d` |
| 93 | news article | `other` | 0.45 | `123289502fc8615a` |
| 94 | news article | `correspondence` | 0.85 | `ad2dfe3ee21dfc69` |
| 95 | news article | `other` | 0.95 | `605cf42c75b79f33` |
| 96 | news article | `other` | 0.95 | `3f011498a8778d8c` |
| 97 | news article | `correspondence` | 0.95 | `f55023dbeb69761a` |
| 98 | news article | `correspondence` | 0.75 | `e0b6fb2d01ac6501` |
| 99 | news article | `correspondence` | 0.75 | `f0b24e21a8622e8b` |
| 100 | budget | `other` | 0.95 | `0d5a427a377d3adf` |
| 101 | budget | `promo_agreement` | 0.85 | `79f247fd0bc70067` |
| 102 | budget | `other` | 0.65 | `18f0a21b38f9f4c6` |
| 103 | budget | `other` | 0.45 | `797891369d88f792` |
| 104 | budget | `price_agreement` | 0.75 | `67e77c6cbd8177f4` |
| 105 | budget | `remittance_advice` | 0.92 | `25e04b8a4df6843a` |
| 106 | budget | `correspondence` | 0.85 | `7e810f47a1745dd9` |
| 107 | budget | `other` | 0.85 | `edea44bfcf5257de` |
| 108 | budget | `promo_agreement` | 0.85 | `bd27346e45a88a72` |
| 109 | budget | `other` | 0.30 | `8918c9e7236f3d06` |
| 110 | invoice | `invoice` | 0.85 | `2021ee43d32847d5` |
| 111 | invoice | `po` | 0.85 | `27d96cea3cbb2e0b` |
| 112 | invoice | `invoice` | 0.95 | `fe8831d19a216e0b` |
| 113 | invoice | `asn` | 0.92 | `0bff7f5a096480ba` |
| 114 | invoice | `invoice` | 0.95 | `21f5309496819200` |
| 115 | invoice | `invoice` | 0.95 | `83e65aced663eb3e` |
| 116 | invoice | `correspondence` | 0.85 | `baa7ca5313dcc4d6` |
| 117 | invoice | `remittance_advice` | 0.85 | `4b1ed9dae264f3ff` |
| 118 | invoice | `invoice` | 0.95 | `372bf87b8b450cd4` |
| 119 | invoice | `invoice` | 0.85 | `607c55234f80c512` |
| 120 | presentation | `routing_guide` | 0.85 | `9a5162f069cabf2d` |
| 121 | presentation | `other` | 0.95 | `d48b0e3a6a61077f` |
| 122 | presentation | `correspondence` | 0.85 | `bb9f79fd964a0b1e` |
| 123 | presentation | `correspondence` | 0.95 | `3cf4033ce465b55e` |
| 124 | presentation | `correspondence` | 0.95 | `ab4ba4b6f1c4eeb8` |
| 125 | presentation | `other` | 0.95 | `40e75c35f968c4fd` |
| 126 | presentation | `other` | 0.85 | `398531b94682c177` |
| 127 | presentation | `correspondence` | 0.95 | `b55f428fc35f4860` |
| 128 | presentation | `other` | 0.75 | `c41d72825671f7b5` |
| 129 | presentation | `other` | 0.95 | `9b1c84ff505e438f` |
| 130 | questionnaire | `other` | 0.95 | `570f77988b371d9b` |
| 131 | questionnaire | `correspondence` | 0.95 | `f97ff53ccf71fbf0` |
| 132 | questionnaire | `other` | 0.95 | `56ac08bff3d754d1` |
| 133 | questionnaire | `other` | 0.85 | `769854a9ad028e8b` |
| 134 | questionnaire | `other` | 0.95 | `c9ce82dc72323721` |
| 135 | questionnaire | `other` | 0.95 | `c7dfd006fceab957` |
| 136 | questionnaire | `other` | 0.95 | `7d87b8827bb2f0ab` |
| 137 | questionnaire | `other` | 0.95 | `daffefa107056761` |
| 138 | questionnaire | `other` | 0.95 | `0aae30645fdca740` |
| 139 | questionnaire | `other` | 0.95 | `f69685a6ea1073ce` |
| 140 | resume | `other` | 0.95 | `6df568d04c21771c` |
| 141 | resume | `other` | 0.95 | `c2ee13a3e4982547` |
| 142 | resume | `other` | 0.85 | `b83851b020a9e7c7` |
| 143 | resume | `other` | 0.95 | `02f66353389f6ef5` |
| 144 | resume | `other` | 0.95 | `5da35dca47ecd84f` |
| 145 | resume | `other` | 0.95 | `f58caf7845f87d48` |
| 146 | resume | `other` | 0.95 | `3b2da40e9d8fc8ad` |
| 147 | resume | `other` | 0.95 | `4c36b0c6d845e373` |
| 148 | resume | `other` | 0.95 | `b6c8f63bf59e54d2` |
| 149 | resume | `other` | 0.99 | `906d43f691cee003` |
| 150 | memo | `correspondence` | 0.92 | `f521ef6a853e6857` |
| 151 | memo | `correspondence` | 0.95 | `2abccc33ba781c1d` |
| 152 | memo | `correspondence` | 0.95 | `550a83da51a9b918` |
| 153 | memo | `correspondence` | 0.95 | `b83186d2c85dca0c` |
| 154 | memo | `correspondence` | 0.95 | `6a1ef4241403bc3e` |
| 155 | memo | `other` | 0.95 | `f744a9673985ee4c` |
| 156 | memo | `other` | 0.95 | `9b5a45638b0f3332` |
| 157 | memo | `other` | 0.95 | `547100f30f511735` |
| 158 | memo | `correspondence` | 0.95 | `df34b39803025678` |
| 159 | memo | `correspondence` | 0.95 | `08e661e1f8fff385` |

</details>

## Redoing it

Download the parquet at the revision above. Convert each `image` to PNG with
Pillow. Build a `DocumentPayload` with `pageText: []` and a neutral filename,
and call `new ClaudeClassifier().classify(payload)` with `ANTHROPIC_API_KEY`
set. Keep the images and the answers outside the repository.
