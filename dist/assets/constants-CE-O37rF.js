const s=2e5,r="SHA-256",l=16,c=12,u=256,p="Xenova/all-MiniLM-L6-v2",d=384,h=2e3,m=6,y=16,g=256,f=["phone","phone number","mobile phone","address","street address","home address","mailing address","date of birth","birth date","dob","ssn","social security number","tax id","passport","passport number","driver license","drivers license","national id","national insurance","bank account","iban","salary","current salary","desired salary","gender","race","ethnicity","sexual orientation","disability","veteran status"],o={classifier:{temperature:0,maxTokens:512},chooser:{temperature:0,maxTokens:128},answer_length:{temperature:0,maxTokens:256},story_answer_prompt:{temperature:.2,maxTokens:600},resume_parse:{temperature:0,maxTokens:10240},story_discovery:{temperature:0,maxTokens:768},generic_key:{temperature:0,maxTokens:512},alias_judge:{temperature:0,maxTokens:64}};function x(t,a){const e=o[t],i=a[t];return{temperature:i?.temperature??e.temperature,maxTokens:i?.maxTokens??e.maxTokens}}const b={activeBackend:"ollama",backends:{anthropic:{apiKey:"",model:"claude-sonnet-4-6"},openai:{apiKey:"",model:"gpt-5-mini"},gemini:{apiKey:"",model:"gemini-3-flash-preview"},ollama:{baseUrl:"http://localhost:11434",model:"gemma4:e4b"}},prompts:{},promptParams:{},matching:{fuseThreshold:.1},rag:{historyGenericKeyWeight:.3,minTokens:1024,contextPercent:25},dedup:{questionSimilarityThreshold:.85,genericKeySimilarityThreshold:.75},logging:{enabled:!0,logPayloads:!1,showDiagnostics:!1},session:{inactivityMinutes:15},navigator:{prevKey:",",nextKey:"."},detector:{maxAncestorHtml:15e3,maxAncestorInnerText:300,maxAncestorLevels:3,extraAncestorLevelsAfterMatch:2,maxAttrValueLen:120,classifierMaxContextLevels:12},customContextWindows:{}},n={classifier:`You are an expert data classification agent routing a job application form field into one of four categories.

<categories>
1. "profile_existing_value": A data point already present in the user's stored data — either a flat profile key, OR a slot inside one of the user's group templates (e.g. a Work Experience or Education record). Group-template fields commonly REPEAT across records (every work experience has its own "job title", "company", "start date", etc.) so when the surrounding HTML places the focused field inside a section that looks like one of these templates, prefer the template target.
2. "profile_update": A basic personal data point NOT yet in the profile and NOT a slot inside any existing group template (e.g., middle name, pronouns, personal website). Suggest a normalized key (lowercase, spaces only).
3. "story_answer": A narrative, open-ended, or experiential question requiring an essay or paragraph (e.g., "Tell us about a time...", "Why this company?").
4. "need_more_context": The surrounding HTML context is genuinely too sparse to determine what the field is asking — for example, the snippet contains only the bare input element with no visible label, legend, aria attribute, or adjacent text. Using this triggers a re-call with one additional level of ancestor HTML. Use sparingly and only when classification is highly uncertain.
</categories>

<context>
Detector-produced label (heuristic — may be inaccurate): {{field_label}}
Field type: {{field_type}}
Available options (if any): {{field_options}}
Existing canonical profile keys: {{profile_keys}}

Existing group templates (each template is a schema for a list of records — Work Experience, Education, etc.):
{{group_templates}}

Pre-selected match candidates from the fuzzy matcher (these are the ONLY plausible "profile_existing_value" targets unless the matcher produced none; pick from this list when non-empty):
{{match_candidates}}

Focused element descriptor:
{{element_descriptor}}

Surrounding HTML context (outerHTML of an ancestor of the focused field — cleaned of styling noise and pruned so cousin subtrees are flattened to their visible text). The focused element inside this snippet is tagged with the attribute data-quickfill-focus="1" — locate it by that marker. This is your PRIMARY source of truth for what the field is asking:
{{ancestor_html}}

Plain-text innerText of the HTML context root (a noise-free sidecar — useful when the HTML is hard to read, but the HTML above is still the primary source):
{{ancestor_inner_text}}
</context>

<instructions>
Determine what the focused field is asking by using the surrounding HTML as your primary source. The HTML shows the real DOM structure near the field, including labels, legends, aria attributes, and sibling content. Use the focused element descriptor to identify which specific element to fill within that HTML. Treat the detector-produced label as a secondary hint only — it may be wrong.

Use the surrounding HTML to:
- Identify the true question or label associated with the focused field
- Decide whether the field belongs to a repeated section (work-experience block, education block, etc.) — if yes, route to a group template
- Understand whether the field expects a brief factual answer or a narrative response
- Recognize explicit labels, fieldset legends, aria-labelledby targets, or text nodes adjacent to the element

When match candidates were pre-selected, you must either pick exactly one of them OR escalate to "profile_update" / "story_answer". Do not invent a different canonicalKey or template.

Only output "need_more_context" when the surrounding context truly does not contain enough signal about what the field is asking. If you can make a reasonable determination, use one of the first three categories instead.
</instructions>

<rules>
Output raw, unformatted JSON only. Begin your response with { and end it with }.
Match exactly one of these output templates:

Template 1a (Existing Value — flat profile key):
{"category": "profile_existing_value", "target": {"kind": "flat", "canonicalKey": "exact_matched_key"}}

Template 1b (Existing Value — group template slot):
{"category": "profile_existing_value", "target": {"kind": "template", "templateName": "exact_template_name", "key": "exact_template_key"}}

Template 2 (New Value):
{"category": "profile_update", "canonicalKey": "suggested_lowercase_key"}

Template 3 (Story Required):
{"category": "story_answer"}

Template 4 (More context needed):
{"category": "need_more_context"}
</rules>

<examples>
If you recognize the Label as "Legal First Name", with flat keys ["first name", "last name", "email"] and no relevant template:
Output: {"category":"profile_existing_value","target":{"kind":"flat","canonicalKey":"first name"}}

If the focused field is "Job Title" inside a section that looks like a work-experience block (e.g. <fieldset> with legend "Experience #2") and a "Work Experience" template exists with a "job title" key:
Output: {"category":"profile_existing_value","target":{"kind":"template","templateName":"Work Experience","key":"job title"}}

If you recognize the Label as "Portfolio URL", with no matching flat key or template slot:
Output: {"category":"profile_update","canonicalKey":"personal website"}

If you recognize the Label as "Describe a complex technical challenge you solved":
Output: {"category":"story_answer"}

If the surrounding HTML only shows <input data-quickfill-focus="1">, or it has a generic label like "Value" with no other text, or possibly with extra encompassing divs with no useful information, or other situations where there is not enough information to determine the field's purpose:
Output: {"category":"need_more_context"}
</examples>

Output:`,chooser:`You are an expert data matcher resolving a stored profile value to a closed list of dropdown/radio options.

<rules>
1. Compare the stored values against the available options using semantic equivalence (e.g., "United States" = "USA"; "Software Engineer" = "Engineering").
2. If a logical match exists, output the EXACT, character-for-character match from the Available options list.
3. If no logical match exists, or the stored value contradicts the options, output the exact phrase: No good options
4. Output strictly the chosen string on a single line. Provide only the text of the option.
</rules>

<context>
Field label / question: {{field_label}}
Canonical profile key: {{canonical_key}}
Stored values: {{stored_values}}
Available options on the page:
{{options}}
</context>

Output:`,answer_length:`You are an expert form analyst. Estimate a sensible maximum character budget for the given field below.

<heuristics>
- 150: One-line factual answers (e.g., Current Company, Links).
- 600: Short, concise answers (e.g., "Briefly describe your role").
- 1500: Medium narratives (e.g., "Tell us about a project").
- 3000: Long essays (e.g., "Cover Letter").
</heuristics>

<context>
Field label / question: {{field_label}}
Field type: {{field_type}}
</context>

<rules>
Output strictly a single integer representing the character count. Provide only the numeric digits on a single line.
</rules>

Output:`,story_answer_prompt:`You are a top-tier professional applying for a job. Write a highly tailored, engaging, and specific answer to the application question.

<application_context>
{{active_application}}
</application_context>

<applicant_data>
Profile: {{profile}}
Relevant Stories: {{stories}}
Past Answers: {{history}}
</applicant_data>

<task>
Question to answer / field label: {{field_label}}
Maximum length: {{max_length}} characters.
</task>

<guidelines>
- Voice: First-person ("I"). Confident, professional, clear.
- Synthesis: Seamlessly weave metrics and facts from the <applicant_data>. Use only the provided experiences. Do NOT hallucinate or invent new experiences.
- Tailoring: Angle the response to directly appeal to the <application_context>.
</guidelines>

<critical_rules>
1. Begin your answer immediately with the first word of your response. 
2. Write in plain text format. Leave out formatting, bullet points, and headers unless EXPLICITLY requested by the prompt.
3. NO introductory fluff ("Here is my answer", "Based on my experience", "Certainly!").
</critical_rules>

Answer:`,resume_parse:`You are an expert data parser who is part of a recruitment data pipeline. Extract structured information from the raw resume text.

<resume_text>
{{resume_text}}
</resume_text>

<rules>
1. Extract standard profile data using common lowercase keys (e.g., "first name", "email"). For fields that REPEAT (multiple work experiences, multiple education entries, multiple activities, multiple publications, etc.), put them in "groupTemplates" as a list of records — DO NOT collapse them into a single string.
2. Identify impactful STAR narratives (Situation, Task, Action, Result) and assign 2-5 thematic keyword tags to each.
   These stories should be narrated in the first-person, as if the applicant is describing their own experience. Focus on unique, specific, and compelling stories that highlight the applicant's skills and achievements.
3. Output raw, unformatted JSON only. Begin your response with { and end it with }.
4. Flat profile values must be plain — use a string, number, or simple array of strings. Use groupTemplates for ANY repeated structured data (work history, education, activities, projects, publications, certifications, languages-with-levels, etc.). Never put arrays-of-objects in "profile".
5. Each group template should have a clear, lowercase \`name\` (e.g., "work experience", "education", "activities") and a \`keys\` list. Each key has a lowercase \`key\` name, an optional \`type\` ("string" | "number" | "boolean" | "array"; default "string"), an optional \`aliases\` array of synonyms (lowercase), and an optional \`sensitive\` boolean.
6. Each record is a flat object whose keys MATCH the template's keys exactly (or one of their aliases). Missing values may be omitted. Boolean values use "yes"/"no". Array-typed values are JSON arrays of strings.
7. Output strictly this exact JSON skeleton (the keys in the profile / template are just typical examples — adapt to whatever the resume actually contains):
</rules>

<output_scheme>
{
  "profile": {
    "first name": "Jane",
    "email": "jane@example.com",
    "skills": ["Python", "React", "SQL"],
    "spoken languages": ["English (native)", "Spanish (intermediate)"],
    "work authorization": "US Citizen"
  },
  "groupTemplates": [
    {
      "name": "work experience",
      "keys": [
        { "key": "job title", "type": "string", "aliases": ["title", "position", "role"] },
        { "key": "company", "type": "string", "aliases": ["employer", "organization"] },
        { "key": "location", "type": "string" },
        { "key": "start date", "type": "string", "aliases": ["from"] },
        { "key": "end date", "type": "string", "aliases": ["to"] },
        { "key": "currently working", "type": "boolean" },
        { "key": "description", "type": "string", "aliases": ["responsibilities"] }
      ],
      "records": [
        {
          "job title": "Senior Software Engineer",
          "company": "Acme Corp",
          "location": "San Francisco, CA",
          "start date": "2022-01",
          "end date": "2024-08",
          "currently working": "no",
          "description": "Led the migration to a microservices architecture..."
        }
      ]
    },
    {
      "name": "education",
      "keys": [
        { "key": "school", "type": "string", "aliases": ["university", "institution"] },
        { "key": "degree", "type": "string" },
        { "key": "field of study", "type": "string", "aliases": ["major"] },
        { "key": "gpa", "type": "string" },
        { "key": "start date", "type": "string" },
        { "key": "end date", "type": "string", "aliases": ["graduation date"] }
      ],
      "records": [
        {
          "school": "MIT",
          "degree": "B.S.",
          "field of study": "Computer Science",
          "gpa": "3.9",
          "start date": "2014",
          "end date": "2018"
        }
      ]
    }
  ],
  "stories": [
    {
      "content": "One to two paragraph STAR narrative in the applicant's own voice",
      "keywords": ["tag1", "tag2"]
    }
  ]
}
</output_scheme>

Output:`,story_discovery:`You are an expert career consultant. Your task is to detect if a user's edited answer contains a NEW, reusable STAR (Situation, Task, Action, Result) narrative.

<context>
Application: {{active_application}}
Question: {{field_label}}
Edited Answer: {{answer}}
</context>

<existing_stories>
{{stories}}
</existing_stories>

<evaluation_logic>
1. SAFETY CHECK: Is the edited answer just a grammatical fix, a shortened version of an existing story, a generic factual statement, or fluff? If YES -> Propose: false.
2. NOVELTY CHECK: Does the edited answer contain materially new experiential data (a new project, a new metric, a distinct challenge) not covered in <existing_stories>? If YES -> Propose: true.
</evaluation_logic>

<rules>
Output raw, unformatted JSON only. Begin your response with { and end it with }. 
Match exactly one of these output templates:

Template 1 (No new story):
{"proposeStory": false}

Template 2 (New story detected):
{"proposeStory": true, "content": "Extracted STAR paragraph", "keywords": ["tag1", "tag2"]}
</rules>

Output:`,generic_key:`You are a semantic tagging agent. Summarize the job application context into a short, generic, company-agnostic phrase.

<context>
Company name: {{company_name}}
Role: {{role}}
User notes: {{user_blurb}}
</context>

<rules>
1. The output MUST capture the industry, company stage/size, and role family.
2. CRITICAL: OMIT the specific company name. If the industry/stage is not obvious, describe only the role.
3. Output raw, unformatted JSON only. Begin your response with { and end it with }.

</rules>

<examples>
Input: Company: "Stripe", Role: "Backend Engineer", Notes: "Payments infrastructure"
Output: {"genericKey": "late-stage fintech, backend infrastructure engineer"}

Input: Company: "Stealth", Role: "Developer", Notes: ""
Output: {"genericKey": "early-stage startup, developer"}
</examples>

Output strictly this exact JSON format:
<output_scheme>
{
  "genericKey": "phrase"
}
</output_scheme>

Output:`,alias_judge:`You are a careful linguistic judge. Decide whether the form-field label below is a genuine ALIAS for the existing canonical profile key — i.e. they refer to the SAME data point and the label would map to that key on ANY form, not just this one.

<context>
Canonical key: {{canonical_key}}
Field label observed on the form: {{field_label}}
Surrounding HTML context (provided ONLY so you can detect when the label is too context-dependent — do NOT use it to justify adding the alias):
{{ancestor_html}}
</context>

<rules>
1. Answer "true" only when the label is a generic synonym, abbreviation, common rewording, or translation that would unambiguously point to the canonical key on a typical form, even with NO surrounding context.
2. Answer "false" when:
   - The label is too peculiar / form-specific (e.g. "your manager's email at Acme Co.", "preferred salutation for the cover letter").
   - The label is too generic / vague (e.g. "info", "details", "value") and matched only because of the surrounding HTML.
   - The label is essentially identical to the canonical key (already covered — no need to add).
   - You are not confident.
3. Output raw JSON only. Match exactly one template:
   {"isAlias": true}
   {"isAlias": false}
</rules>

<examples>
Canonical key: "first name"; Label: "Given name" -> {"isAlias": true}
Canonical key: "phone number"; Label: "Mobile" -> {"isAlias": true}
Canonical key: "email"; Label: "Reference #2 email at previous employer" -> {"isAlias": false}
Canonical key: "linkedin"; Label: "URL" (only matched via surrounding context) -> {"isAlias": false}
</examples>

Output:`};function _(t,a){const e=a[t];return typeof e=="string"&&e.trim().length>0?e:n[t]}export{c as A,b as D,p as E,s as K,h as L,y as R,f as S,o as a,n as b,u as c,l as d,r as e,g as f,m as g,x as h,d as i,_ as r};
//# sourceMappingURL=constants-CE-O37rF.js.map
