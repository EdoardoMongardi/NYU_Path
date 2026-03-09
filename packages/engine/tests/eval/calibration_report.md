# Judge Calibration Report

**Date**: 2026-03-08
**Total claims evaluated**: 142
**Cohen's κ**: 0.139
**Status**: ❌ Needs iteration

## Per-Class Metrics

| Label | Precision | Recall | F1 | Support |
|-------|-----------|--------|-----|---------|
| grounded | 0.69 | 0.99 | 0.81 | 94 |
| hallucinated | 0.00 | 0.00 | 0.00 | 37 |
| contradicted | 0.60 | 0.30 | 0.40 | 10 |
| insufficient_evidence | 0.50 | 1.00 | 0.67 | 1 |

## Overall Quality (Human Labels)

| Metric | Value | Target |
|--------|-------|--------|
| Grounding Rate | 66.2% | ≥ 95% |
| Hallucination Rate | 26.1% | ≤ 3% |
| Contradiction Rate | 7.0% | 0% |
