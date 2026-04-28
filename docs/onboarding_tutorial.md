# NYU Path — Onboarding Tutorial

You'll upload one file: your **Albert Degree Progress Report (DPR)** as a PDF. Three steps, ~2 minutes total.

## Step 1: Open Albert

Go to [shibboleth.nyu.edu](https://shibboleth.nyu.edu) and log in with your NYU NetID + password + Duo MFA.

You'll land on Albert's Student Center. The page has tabs across the left: **Home**, **Academics**, **Other Resources**.

## Step 2: Find the Degree Progress Report

Click the **Academics** tab. You'll see a panel called **Planning Tools** with these links:

- Academic Planner
- Academic Planner FAQ
- **Degree Progress Report** ← click this one
- Minor Application
- What If Report

Clicking **Degree Progress Report** opens a new browser window with the report. The DPR is multi-page — it covers:

- Your declared programs (career / college / major / minor)
- Cumulative credits + GPA
- Each requirement group (CORE, major, residency, P/F budget, etc.)
- Course history at the bottom (every course you've taken with grades)

If the DPR window doesn't open, your popup blocker may be the issue — temporarily allow popups for `albert.nyu.edu` and click the link again.

## Step 3: Save the DPR as PDF

Once the report is fully loaded in its window:

- **Mac**: ⌘+P (print) → in the print dialog, change the destination to **Save as PDF** → Save.
- **Windows**: Ctrl+P → change printer to **Microsoft Print to PDF** → Save.
- **Either**: any other "Print to PDF" option in your browser works the same way. The file will be ~30–50 KB.

Then drag the saved PDF onto NYU Path's chat page, or click the 📎 button and pick the file.

## What you should see after upload

NYU Path parses the DPR (deterministic, no LLM — typically ~1 second) and shows a confirmation summary:

```
Got it! I read your Degree Progress Report (file.pdf, 0.0 MB).

[Your Name] — UA-Coll of Arts & Sci (Program), [Your Major] (Major Approved)
[X] of [128] credits earned • GPA: [X.XXX]
Pass/Fail used: [X] of 32 units
Outside-home credits: [X] of 16 units

[N] requirements still to satisfy. I'll walk you through them when you're ready.

Does this look right? (yes / no)
```

If the numbers match what your DPR shows, reply "yes." If something looks off, reply "no" — the operator will help you debug.

## Troubleshooting

- **"I extracted the text but couldn't recognize the Degree Progress Report layout"** — you uploaded a different document (e.g., the Academic Planner form, the What-If Plan input form, or a transcript). Re-export the DPR specifically.
- **"That PDF is X MB — please upload a file under 10 MB"** — DPRs are tiny (~30–50 KB). If your file is much larger, something captured extra pages. Re-print just the DPR window.
- **"I couldn't read text out of that PDF"** — your save-as-PDF probably saved as an image (a screenshot saved as PDF). Use the browser's File → Print → Save as PDF instead of taking a screenshot.

## Fallback: upload your unofficial transcript

If the DPR is genuinely not loading for you, click the "Can't access your DPR? Upload an unofficial transcript instead" link below the upload box. NYU Path will run on the transcript instead. The audit data is less rich (no DPR-computed verdicts, no P/F budget, etc.) but it works.

Path: Albert → Student Center → Academics → **View Unofficial Transcript** → save as PDF.

## Re-uploading later

You'll want to re-upload your DPR whenever:

- You register for new courses (the audit + plan tools see the updated state).
- You declare a new major or minor.
- You see grades you didn't see last time.

Just upload the fresh PDF; it replaces the in-memory one for the current chat. (Cohort A doesn't persist anything across sessions — see [PRIVACY.md](../PRIVACY.md) §2.3 — so a re-upload simply gives the agent the latest snapshot of your DPR for the current conversation.)

## Privacy reminder

Per [PRIVACY.md](../PRIVACY.md):
- The PDF is processed in memory and never written to disk.
- The parsed JSON lives in your browser only (cleared when you close the tab).
- We don't have your NYU credentials and never log into Albert on your behalf.

If anything in the system feels off, email the operator at edoardo.mongardi18@gmail.com.
