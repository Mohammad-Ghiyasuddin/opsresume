# OpsReady

A focused job application workspace for DevOps, Site Reliability Engineering, Cloud, and Platform Engineering roles. It compares a resume with a target job description, prepares editable application drafts, and provides optional AI-powered resume, cold-email, and cover-letter refinement through OpenAI, Anthropic Claude, or Google Gemini.

## Run locally

Install Node.js 20 or later. Copy `.env.example` to `.env` and add at least one API key. Then run:

```powershell
npm start
```

Open <http://localhost:8000>. The local server reads keys from `.env`; they are not sent to or included in browser code. AI drafting sends your resume and job description to the provider you select, so review its privacy and data-retention terms before use. Do not expose this unauthenticated local service to the public internet.

The app works without an API key: use **Build application drafts** for local, template-based drafts. **Improve drafts with AI** requires a configured provider key.

## Configure provider keys

Add one or more keys to `.env`:

```dotenv
OPENAI_API_KEY=your_openai_api_key
ANTHROPIC_API_KEY=your_anthropic_api_key
GEMINI_API_KEY=your_gemini_api_key
```

Restart `npm start` after changing keys. Select the provider in the AI writing assistant and keep the suggested model ID or enter a model enabled for your account. API availability, free quotas, and prices depend on the provider and may change. OpenAI API usage is separately billed by token; Claude API access may require paid credits; Gemini has a limited free tier for selected models and its free tier may use submitted content to improve products. Check current provider terms and billing before use.

## Run with Docker Compose

Docker Compose reads the same `.env` file in this folder:

```powershell
docker compose up --build
```

Open <http://localhost:8080>. The published port is bound to localhost. Stop with `Ctrl+C`; run `docker compose down` to remove the container.

## Features

- Resume and job-description upload or paste, with a DevOps, SRE, or platform role focus
- Browser-side extraction for TXT, DOCX, and PDF; OCR for job-description images
- AI-powered resume, cold-email, and cover-letter refinement with OpenAI, Claude, or Gemini (optional API keys)
- Editable resume and email drafts, copy actions, and resume PDF or text download
- Editable role-grounded cover letter with PDF export
- Role-specific keyword alignment estimate and actionable missing-term suggestions
- Resume checks for contact details, measurable outcomes, and experience or project structure
- Job application link opens the employer's site; local application tracker stores roles and status in this browser
- Light, dark, and system theme selection, with a reduced-motion accessibility preference
- Local Node.js server and Docker Compose setup

## Notes

PDF, DOCX, and image extraction load their reader libraries from public CDNs when needed. PDF export runs locally in the browser. Google Fonts are also loaded from Google Fonts. Resume and job description text stays in the browser unless you explicitly choose AI draft generation; that sends the text to your selected AI provider through the local server. AI output may be inaccurate: verify every skill, date, metric, achievement, and contact detail before use. The keyword percentage is a transparent estimate, not an official ATS score or hiring prediction. The app does not guarantee a score or shortlisting.
