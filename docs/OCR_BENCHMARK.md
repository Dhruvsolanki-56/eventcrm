# Card OCR benchmark and limits

## What is in the benchmark

`npm run generate:ocr-benchmark` creates 1,200 fictional English business-card images and exact field labels. The cards use six designed layouts, six palettes, several installed fonts, and small simulated blur, glare, contrast, and rotation changes. The manifest labels 960 records for development and keeps 240 (one fifth) held out. No real people's contact information is included. The generated images and OCR result files live below ignored `data/`; they are reproducible from the checked-in scripts and are not committed.

This is a synthetic benchmark, not a collection of 1,200 real cards. It tests the image-to-text-to-fields path against controlled layouts, but cannot establish accuracy on real event photos, other languages, handwriting, unusual card proportions, or camera devices.

## Data sourcing and model-training status

I did not download a third-party card dataset. The [EATEN repository](https://github.com/beacandler/EATEN) describes 200,000 synthetic business-card images, but its repository page does not state a dataset reuse license, so it was not treated as permission to incorporate the files. The [Humans in the Loop OCR dataset](https://humansintheloop.org/resources/datasets/arabic-documents-ocr-dataset/) is CC0 and has 10,000 mixed Arabic document images, but it is not a suitable source of English business cards with the target field labels.

The application uses Tesseract.js. Its [project scope says the wrapper does not modify or train the recognition model](https://github.com/naptha/tesseract.js#project-scope); the underlying Tesseract project documents a separate [LSTM training workflow](https://tesseract-ocr.github.io/tessdoc/tess5/TrainingTesseract-5.html). The required Tesseract training executables are not installed in this workspace. No OCR character model has been trained here. The work in this change is conservative field extraction, a second page-layout pass when the name is absent, and a focused footer crop when the company is absent—not a claim of model training.

## Held-out results

Exact normalized field matches from the 240 held-out synthetic cards, 40 per layout:

| Field | Single-block pass | Sparse-text pass | Combined fallback |
| --- | ---: | ---: | ---: |
| Name | 91.3% | 96.3% | 99.2% |
| Title | 91.7% | 93.8% | 91.7% |
| Company | 96.7% | 90.4% | 96.7% |
| Email | 84.2% | 84.2% | 84.2% |
| Phone | 97.9% | 100% | 97.9% |
| Website | 74.2% | 73.3% | 74.2% |

The combined strategy keeps the single-block fields and uses sparse-text OCR only to fill a missing name. It recovered 19 of 21 names the first pass missed; split-column name accuracy rose from 52.5% (21/40) to 100% (40/40). The company/person swap check reported zero cases on these 240 synthetic records. That check is a narrow automated signal, not proof that every extracted name is semantically correct.

The footer crop read the company correctly on 38/40 held-out cards of that layout (95%). It did not add exact company matches to the full 240-card held-out set, because its remaining footer errors overlapped with the full-card errors. It does recover a separate deterministic regression fixture where the full-card pass reads no company. The crop is therefore retained only as a last-resort review aid when the company is blank. Extracted values remain marked for user review.

The weakest fields remain website (74.2%) and email (84.2%) exact match. OCR still makes character substitutions in URLs and addresses; users must review those values before saving. Never treat the displayed confidence as a guarantee.

## Timing

Local Node/Tesseract benchmark on this workstation, four OCR workers, 240 full-size images per mode:

- Single-block: 54.686 s total, 227.9 ms per card on average.
- Sparse-text: 50.705 s total, 211.3 ms per card on average.
- The separate 40-card footer crop pass took 6.897 s, 172.4 ms per crop on average.

These are local OCR-throughput measurements, not phone latency or hosted-service timing. Playwright end-to-end test durations for the normal, split-column, and footer cases were 4.5 s, 3.8 s, and 3.4 s respectively; those include sign-in, upload, navigation, OCR, and assertions on the test runner.

## Reproduce

```powershell
npm run generate:ocr-benchmark
npm run benchmark:ocr -- data/ocr-benchmark --split=test --workers=4 --run=baseline-test-v2
python scripts/crop_ocr_benchmark_footer.py data/ocr-benchmark --output data/ocr-lower-crops-test --split test --layout all
npm run benchmark:ocr -- data/ocr-lower-crops-test --mode=single-block --workers=4 --run=lower-crop-test-v1
npm run benchmark:ocr:fallbacks -- data/ocr-benchmark/results/baseline-test-v2 data/ocr-benchmark/results/baseline-test-v2 data/ocr-lower-crops-test/results/lower-crop-test-v1
```

The benchmark refuses to overwrite image output and result files. Use a new `--run` name and a new crop output folder for each run.

## Verification

- `npx vitest run shared/card-ocr.test.ts` — 12 passed.
- `npm test -- --pool=threads --maxWorkers=1` — 43 passed.
- `npm run build` — passed.
- `npm run test:manual-reading` — 5 passed, including phone and desktop layouts, normal upload, split-column name fallback, and footer-company fallback.

This work improves tested cases; it does not make OCR perfect or establish production-grade recognition. A real-world validation set should consist of consented event cards, with exact labels and images kept in an appropriately protected workspace.

## Other card formats and company positions (2026-10-04)

The main benchmark uses one card size. `scripts/generate_ocr_formats.py` adds two stress sets of fictional cards, scored with the same `benchmark:ocr` command:

```powershell
python scripts/generate_ocr_formats.py --output data/ocr-formats                         # 12 formats x 40 cards
python scripts/generate_ocr_formats.py --set positions --output data/ocr-positions       # 10 company positions x 40 cards
npm run benchmark:ocr -- data/ocr-formats --split=test --mode=single-block --workers=4 --run=my-run
```

Formats: portrait, dark background, centered, minimal, labeled E/T/W lines, names in capitals, Indian formats (+91, .co.in, Pvt. Ltd.), address and tagline lines, accents and hyphens, phone-photo distortion, low resolution, and two phone numbers. Company positions: top-right, middle, bottom, under the title, colored sidebar, company larger than the name, top band, footer bar, split over two lines, small beside a corner logo.

Whole-card exact match (every field that exists on the card correct), using the app's real order of passes (a missing name is filled from the sparse-text pass):

| Set | Before this work | After |
| --- | ---: | ---: |
| 12 formats (480 cards) | 75% | 86% |
| Names in capitals | 30% | 95% |
| Dark background | 82% | 95% |
| Slogan or address lines | 70% | 88% |
| 10 company positions (400 cards) | 75% | 88% |
| Company split over two lines | 0% | 90% |
| Main 240-card held-out set: name / company / email | 91.2 / 96.7 / 84.2% | 94.6 / 98.8 / 94.2% |

Still weak: phone-photo distortion (45%) and low resolution (50%), mostly email and website characters; the colored-sidebar layout (company 35%, white text on colour that the reader often misses). Enlarging small images, or flipping dark ones, was tried and did not help overall, so it is not used. All cards are synthetic; real photos have more variety.
