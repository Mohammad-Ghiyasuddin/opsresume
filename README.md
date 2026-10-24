# OpsReady

OpsReady is a local job-application workspace for DevOps, cloud, Site Reliability Engineering (SRE), and platform engineering roles. Use it to tailor a resume to a job description, review keyword alignment, prepare a cover letter and recruiter email, and open the employer's application page.

## Features

- Paste or upload a resume and paste a job description; upload a job-description image for OCR.
- Generate a tailored resume, cover letter, and cold email with Google Gemini.
- Edit drafts before exporting a resume as PDF or text and a cover letter as PDF.
- Review a role-keyword coverage estimate and click suggested terms to add them to the resume. Only keep terms that accurately describe your experience.
- Open the supplied job link to continue on the employer's site.
- Choose a light, dark, or system theme.
- Run locally with Node.js or with Docker Compose.

## Requirements

- Node.js 20 or later for the local server, or Docker with Docker Compose.
- A Google Gemini API key for AI-generated drafts. Without a key or when Gemini is unavailable, the app provides a local template fallback.

## Run locally

1. Copy `.env.example` to `.env` and add your Gemini API key.
2. Start the app:

   ```powershell
   npm start
   ```

3. Open <http://localhost:8000>.

Restart the server after changing `.env`.

## Run with Docker Compose

Create `.env` as described above, then run:

```powershell
docker compose up --build
```

Open <http://localhost:8080>. The Compose port is bound to localhost. Stop the service with `Ctrl+C`, or run `docker compose down` from another terminal.

## Privacy and accuracy

The app is intended for local use and its server binds to localhost by default. Do not expose it to the public internet without adding authentication and other appropriate protections. Keep `.env` private; it is excluded from Git. Never commit API keys.

Resume and job-description text is processed in your browser unless you generate drafts with Gemini. AI generation sends that text to Google's Gemini API using your key. Review Google's current privacy and data terms before sending personal information. Some document-reading libraries and fonts load from public CDNs.

Review every generated claim, date, skill, metric, and contact detail before applying. OpsReady's keyword percentage is an estimate of selected job-description terms found in the resume; it is not an official ATS score or a hiring prediction, and the app cannot guarantee a particular score or shortlisting.
