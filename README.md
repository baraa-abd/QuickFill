# QuickFill - Version 1.0

## Author

* **Al Baraa Abd Aldaim** - [baraa-abd](https://github.com/baraa-abd)

## License

This project is licensed under the **MIT License**.

Copyright (c) 2026 Your Name

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## Introduction
QuickFill is a user-centric Chrome extension designed to help you apply to jobs quickly, easily, and without redundancies. Rather than aggressively auto-filling whole pages or tracking your every move, QuickFill puts you in control: it only triggers when you focus on a specific form field and press a shortcut. This also avoids having the extension break with every change in the DOM layout of a website. The goal is not to replace you, but to make your job application process smooth and easy. 

The extension stores your profile (think basic facts shared across all job applications), a "stories list" (a list of STAR-style stories to use in generating answers to open-ended questions), and an answer history (open-ended answers that the user edited and confirmed; these are used in a RAG pipeline to guide future answer generation). It keeps your data entirely private—all profiles, stories, and answer histories are stored locally and encrypted behind a master password. 

The LLM backends supported include Ollama (local), Anthropic, Google Gemini, and OpenAI. 

## Installation and Usage Guide

### Installation
Since this extension is in active development, you can load it locally into Chrome:
1. Clone this repository.
2. Run `npm install` to install dependencies.
3. Run `npm run build` to bundle the extension via Vite.
4. Open Chrome and navigate to `chrome://extensions/`.
5. Toggle **Developer mode** on in the top right corner.
6. Click **Load unpacked** and select the generated build directory (usually `dist`).

Or alternatively, download the `dist` folder from the repo and then proceed from step 4 above. 

*Note: for the extension to run properly you will likely need to set-up the shortcuts in chrome://extensions/shortcuts. 

### Onboarding
When you install QuickFill for the first time, a setup wizard will open in a new tab:
1. **Master Password & Recovery:** Set a master password. This creates the local encryption key for all your data. A recovery phrase will be generated—save it somewhere safe. Without either, your data is completely unrecoverable.
2. **AI Backend Setup:** Choose your preferred LLM provider (Anthropic, OpenAI, Gemini) and paste your API key, or select Ollama for a purely local setup.
3. **Resume Upload:** Upload your resume (`.docx` or `.txt` only) to let the AI automatically parse your basic profile info and extract initial "stories" of your work experience. You can review and edit these before saving.

### Using the Extension
QuickFill is strictly triggered by keyboard shortcuts. It relies on a Side Panel UI to keep you informed of what it's doing.

* **Auto-Fill a Field (`Alt+A`):**
  Focus on any form field (or hover over it) and press `Alt+A`. 
  * If it's basic profile data (like your name or email), QuickFill instantly types it in.
  * If it requires a narrative answer (e.g., "Describe a complex project you led"), the AI will look at the active application's context and your past stories, and then stream a tailored draft into the Side Panel. You can edit the text, approve it to write it to the page, or cancel. The LLM call here includes the profile, the story list, and a portion of the answer history retrieved through a semantic search (on "generic keys", which are company-agnostic keys generated from company name, role and a user-provided blurb).  
* **Auto-Fill a Field (`Alt+Shift+A`) with manual label:**
  If the above doesn't work this lets you skip the auto-detection of the label and instead lets you highlight the label and press Enter to select it, then proceeds the same way as the above. 
* **Save to Profile (`Alt+S`):**
  If you manually type a great answer or fill in a new field, press `Alt+S` while focused on it to save that exact value to your encrypted profile for future reuse.
* **Smart Story Discovery:** If you edit an AI-generated answer before approving it, QuickFill will check if your edits contain a new reusable "story" and offer to save it for future applications.

### Options & Customization
You can access the Options page by clicking the QuickFill icon in your browser toolbar. Features include:
* **Profile & Stories:** View, add, edit, or mask sensitive fields (which are automatically hidden from cloud AI providers). 
* **Answer History:** Search or delete past generated answers.
* **Prompts:** Power users can view and directly edit the exact system prompts the extension uses for tasks like classification, story generation, and resume parsing. The user can also adjust the temperature and maxTokens for each LLM call type. 
* **Advanced Thresholds:** Tweak the fuse.js similarity threshold (for direct matches), semantic search (RAG) weights, and deduplication thresholds.
* **Backup/Restore:** Export a fully encrypted portable backup of your profile, history, and settings. You can also import this backed up data. 

## How the Extension Was Built

QuickFill was built using generative AI in **Claude Code**, combining automated generation with a human-in-the-loop pipeline. 

The process began by building the design document (`desired_extension_design.md`) through an iterative loop:
1. I initially drafted an outline of the extension's philosophy and architecture.
2. I had Claude generate a comprehensive design document based on the outline.
3. I manually edited the generated document to refine the constraints.
4. I had Claude iterate on it again to patch holes in the logic.
5. Repeated steps 3 & 4 until I was satisfied.
6. I fed the document to other LLMs to gather notes and critiques, and then made manual edits based on that feedback.
7. Claude performed a final iteration to solidify the specifications.

**Implementation details:**
* **Planning Phase:** Used Opus 4.7 with max effort to build the design document, and to build a phased plan to be used as a to-do list during implementation, with natural breaks for testing.
* **Implementation Phase:** Used Opus 4.7 with high effort to generate the codebase. Along the way, changes were made, including to the design document, when it became clear certain parts of the design needed clarification or fleshing out.
* **Debugging Phase:** Used Sonnet 4.6 with high effort to resolve bugs and make slight improvements.

*Note: the final extension implementation might not fully agree with every specific detail in the original `desired_extension_design.md` document. Changes in the debugging phase were not reflected in that document.*

## Some technical details
Field label detection: to save tokens, the extension first uses a locally run "tree-climbing" script that tries to find the question label without using the LLM. This is then combined with fuzzy search (fuse.js) to try and find a match in the profile. If it doesn't exist (which could be either due to a piece of information actually missing from the profile, or due to the label found being bad/incorrect), this is passed to the LLM with more html context around the focused field, allowing the LLM to identify the label more accurately. If these still cause an issue, the user can use manual label highlight (Alt+Shift+A). 

Answer generation: whenever the LLM decides a question is a "story-based" answer, the extension prompts the LLM with extra context: 1- the job info (company name, role, short blurb) provided by the user. 2- the user profile and story list. 3- a portion of the answer history retrieved via semantic similarity on the "generic key", which is a company-agnostic key produced from the job info (via an LLM call) that is used to identify past answers used for similar jobs. For example, if we have (Company: "Stripe", Role: "Backend Engineer", Notes: "Payments infrastructure"), the LLM might produce the generic key "late-stage fintech, backend infrastructure engineer".

## Repository Structure
* `/dist` - built extension.
* `/public` - contains the icon files.
* `/src` - Contains all extension source code.
* `/tests` - Vitest test suites.
* `desired_extension_design.md` - The foundational architectural spec.
* `vite.config.ts` & `svelte.config.js` - Build configuration.
* `package.json` - Dependencies and build scripts.
* `README.md` - this file. 
