// Industry playbook (Amendment 4): common ways businesses of each type use AI and automation.
// Server-owned text, like PROOFS: the model only ever picks industry and pattern ids, and the
// visitor sees this text, never a model paraphrase of it.
//
// Rules for every pattern text: plain, anti-hype Offshorly voice; UK English; describes how
// businesses of this type commonly use AI or automation for the work. No figures, no company or
// product names, no adoption claims ("most firms", "the majority"), no studies or surveys.
// Titles: 8 words or fewer, sentence case. Texts: 35 words or fewer.
import type { ServiceId } from './types.js';

export type IndustryId =
  | 'accounting'
  | 'legal'
  | 'financial-services'
  | 'insurance'
  | 'property'
  | 'recruitment'
  | 'healthcare'
  | 'construction-trades'
  | 'manufacturing'
  | 'logistics'
  | 'ecommerce-retail'
  | 'hospitality-travel'
  | 'education-training'
  | 'agencies'
  | 'software-saas'
  | 'nonprofit';

export interface IndustryPattern {
  /** `<industry id>.<slug>`, or `other.<slug>` for the generic set. */
  id: string;
  /** ≤8 words, sentence case. */
  title: string;
  /** ≤35 words. Server-owned; shown to the visitor as written. */
  text: string;
  /** One of OPPORTUNITY_SERVICE_IDS. */
  serviceId: ServiceId;
}

export interface Industry {
  id: IndustryId;
  label: string;
  /** The label as written mid-sentence ("examples from construction and trades"). */
  phrase: string;
  /** Lowercase alternative names, to help the model match a site to an id. */
  aliases: string[];
  /**
   * Web-search queries for this industry (Amendment 5 Phase 5). Server-owned and built from the
   * industry alone: never from a visitor's answers, email or the audited site. Changing them means
   * bumping QUERIES_VERSION in server/search/industryResearch.ts.
   */
  searchQueries: readonly [string, string];
  patterns: IndustryPattern[];
}

/** Industry id used when nothing in the playbook fits. Its patterns are GENERIC_PATTERNS. */
export const OTHER_INDUSTRY = 'other' as const;
export type IndustryChoice = IndustryId | typeof OTHER_INDUSTRY;

/** Label shown for `other` when the model gives no usable label of its own. */
export const OTHER_INDUSTRY_FALLBACK_LABEL = 'Businesses like yours';

const p = (id: string, title: string, serviceId: ServiceId, text: string): IndustryPattern => ({ id, title, text, serviceId });

export const INDUSTRIES: Record<IndustryId, Industry> = {
  accounting: {
    id: 'accounting',
    label: 'Accounting',
    phrase: 'accounting',
    aliases: ['accountants', 'accountancy practice', 'bookkeeping', 'tax advisers', 'payroll bureau'],
    searchQueries: ['how UK accountancy practices use AI automation', 'AI tools for accountants bookkeeping case study UK'],
    patterns: [
      p('accounting.records-collection', 'Chasing and sorting client records', 'ai-automation',
        'Missing records are requested automatically, receipts and statements are read as they arrive, and each is filed against the right client before anyone starts the books.'),
      p('accounting.bank-coding', 'Coding bank transactions', 'ai-automation',
        'Rules plus AI suggest a category for each routine transaction, learn from corrections, and leave only the unusual items for a bookkeeper to check.'),
      p('accounting.working-papers', 'Preparing year-end working papers', 'ai-agent-development',
        'Ledgers, prior-year files and client answers are pulled into first-draft working papers, with open queries listed for the accountant to resolve.'),
      p('accounting.client-questions', 'Answering routine client questions', 'ai-automation',
        'An assistant drafts replies to common questions about deadlines, documents needed and where a return has got to, using the practice records, for staff to approve.'),
      p('accounting.onboarding', 'Onboarding and identity checks', 'ai-automation',
        'New clients go through engagement letters, identity checks and data collection in one guided flow, with exceptions passed to a person.'),
      p('accounting.commentary', 'Drafting management accounts commentary', 'ai-agent-development',
        'Monthly figures are turned into a plain-language note on what changed and why, which the accountant edits before it goes to the client.'),
    ],
  },
  legal: {
    id: 'legal',
    label: 'Legal',
    phrase: 'legal',
    aliases: ['law firm', 'solicitors', 'barristers chambers', 'conveyancing', 'legal services'],
    searchQueries: ['how UK law firms use AI automation', 'AI tools for solicitors case study UK'],
    patterns: [
      p('legal.intake', 'Triage of new enquiries', 'ai-automation',
        'Enquiries are read as they arrive, sorted by matter type and urgency, and passed to the right fee earner with the key facts summarised and conflict checks started.'),
      p('legal.document-review', 'First-pass document review', 'ai-agent-development',
        'AI reads contracts or disclosure bundles against a checklist, flags unusual clauses and missing terms, and leaves the judgement to a lawyer.'),
      p('legal.precedent-drafting', 'Drafting from the firm’s precedents', 'ai-automation',
        'Standard letters, engagement terms and routine agreements are drafted from the firm’s own precedents and matter details, then checked by the responsible lawyer.'),
      p('legal.conveyancing-searches', 'Summarising searches and enquiry replies', 'ai-agent-development',
        'Search results and replies to enquiries are read and summarised, with issues raised for the conveyancer rather than found by reading every page.'),
      p('legal.time-narratives', 'Time recording and bill narratives', 'ai-automation',
        'Time entries are suggested from the emails, calls and documents worked on, and bill narratives drafted for the fee earner to confirm.'),
      p('legal.client-updates', 'Keeping clients updated on their matter', 'ai-automation',
        'Progress updates are drafted from the case record at each milestone, so clients hear news without chasing and staff take fewer update calls.'),
    ],
  },
  'financial-services': {
    id: 'financial-services',
    label: 'Financial services',
    phrase: 'financial services',
    aliases: ['financial advisers', 'wealth management', 'mortgage brokers', 'lenders', 'fintech'],
    searchQueries: ['how UK financial advisers and mortgage brokers use AI automation', 'AI in UK wealth management firms case study'],
    patterns: [
      p('financial-services.suitability-reports', 'Turning fact-finds into suitability reports', 'ai-agent-development',
        'Meeting notes and fact-find answers are pulled into a first-draft suitability report in the house style, for the adviser to review and sign off.'),
      p('financial-services.due-diligence', 'Client due diligence checks', 'ai-automation',
        'Identity documents and source-of-funds evidence are read and checked against the firm’s rules, with gaps and anomalies routed to compliance staff.'),
      p('financial-services.application-packaging', 'Packaging loan and mortgage applications', 'ai-automation',
        'Payslips, statements and application forms are read, key details extracted and cross-checked, and missing items requested before an underwriter sees the case.'),
      p('financial-services.annual-reviews', 'Preparing annual client reviews', 'ai-automation',
        'Portfolio data, notes from the last meeting and changes in circumstances are gathered into a review pack, so the adviser starts from a draft.'),
      p('financial-services.compliance-monitoring', 'Checking calls and files for compliance', 'ai-agent-development',
        'Call transcripts and client files are checked against the firm’s compliance rules, with likely issues flagged for a supervisor instead of sampling by hand.'),
      p('financial-services.service-requests', 'Handling routine client service requests', 'ai-automation',
        'Requests such as address changes, valuations and withdrawal forms are recognised, prepared and queued for approval, so staff handle only the exceptions.'),
    ],
  },
  insurance: {
    id: 'insurance',
    label: 'Insurance',
    phrase: 'insurance',
    aliases: ['insurance broker', 'underwriting agency', 'claims management', 'insurer', 'mga'],
    searchQueries: ['how UK insurance brokers use AI automation', 'AI claims handling insurance broker case study UK'],
    patterns: [
      p('insurance.submissions', 'Reading broker submissions', 'ai-automation',
        'Submissions arriving by email are read, key risk details entered into the underwriting system, and incomplete ones sent back with a list of what is missing.'),
      p('insurance.claims-intake', 'First notice of loss intake', 'ai-automation',
        'Claim notifications from calls, forms and emails are captured, checked for basic cover, and routed by type and severity to the right handler.'),
      p('insurance.claims-documents', 'Reviewing claims documents', 'ai-agent-development',
        'Reports, invoices and photos are read against the policy wording, with inconsistencies and possible fraud indicators flagged for a claims handler to judge.'),
      p('insurance.renewals', 'Preparing renewal packs', 'ai-automation',
        'Renewal data is gathered, changes since last year highlighted, and quotes and letters drafted, so brokers spend their time on the conversation.'),
      p('insurance.wording-comparison', 'Comparing policy wordings', 'ai-agent-development',
        'Policy wordings and schedules are compared line by line, with differences in cover summarised for a broker or underwriter to review.'),
      p('insurance.bordereaux', 'Cleaning and reconciling bordereaux', 'ai-automation',
        'Partner data arriving in different formats is mapped, checked and reconciled automatically, leaving only the mismatches for someone to resolve.'),
    ],
  },
  property: {
    id: 'property',
    label: 'Property',
    phrase: 'property',
    aliases: ['estate agents', 'letting agents', 'property management', 'block management', 'surveyors'],
    searchQueries: ['how UK estate and letting agents use AI automation', 'AI tools for property management firms UK case study'],
    patterns: [
      p('property.enquiry-qualifying', 'Qualifying property enquiries', 'ai-automation',
        'Portal and website enquiries are answered quickly, questions about budget and timing asked, and viewings booked, with serious applicants passed to a negotiator.'),
      p('property.referencing', 'Tenant referencing and onboarding', 'ai-automation',
        'Applicant documents and references are collected, read and checked, with a summary and any gaps flagged for the lettings team before a tenancy is offered.'),
      p('property.maintenance-triage', 'Triage of maintenance requests', 'ai-agent-development',
        'Repair requests are logged from messages and photos, sorted by urgency, matched to the right contractor, and chased without staff relaying every update.'),
      p('property.listings', 'Writing property listings', 'ai-automation',
        'Listing descriptions are drafted from notes, floorplans and photos in the agency’s own tone, ready for a negotiator to check and publish.'),
      p('property.compliance-dates', 'Tracking certificates and compliance dates', 'ai-automation',
        'Safety certificates, licences and deposit paperwork are read, expiry dates tracked, and reminders sent to landlords and contractors before anything lapses.'),
      p('property.survey-reports', 'Drafting valuation and survey reports', 'ai-agent-development',
        'Site notes, photos and comparable evidence are pulled into a first-draft report, so the surveyor spends time on judgement rather than formatting.'),
    ],
  },
  recruitment: {
    id: 'recruitment',
    label: 'Recruitment',
    phrase: 'recruitment',
    aliases: ['recruitment agency', 'staffing', 'executive search', 'headhunters', 'talent acquisition'],
    searchQueries: ['how UK recruitment agencies use AI automation', 'AI tools for recruiters case study UK'],
    patterns: [
      p('recruitment.cv-screening', 'Screening applications against the brief', 'ai-agent-development',
        'Applications are read against the role brief, strengths and gaps summarised, and a shortlist suggested for a consultant to review and decide.'),
      p('recruitment.database-search', 'Searching the existing candidate database', 'ai-automation',
        'Past candidates are searched by skills and experience rather than keywords, so good people already on file are found before paying to advertise.'),
      p('recruitment.cv-formatting', 'Formatting candidate profiles for clients', 'ai-automation',
        'Candidate details are moved into the agency template, contact details removed and a short profile written, ready for a consultant to send.'),
      p('recruitment.interview-scheduling', 'Scheduling interviews', 'ai-automation',
        'Interview slots are offered, confirmed and rescheduled by message, with reminders sent to candidates and clients, so consultants stop juggling calendars.'),
      p('recruitment.job-adverts', 'Writing job adverts and specs', 'ai-automation',
        'Adverts and job specs are drafted from intake call notes in a consistent format, checked for biased wording, and adjusted by the consultant.'),
      p('recruitment.right-to-work', 'Right-to-work and compliance checks', 'ai-automation',
        'Identity and right-to-work documents are collected and checked against the agency’s rules, with expiry dates tracked and exceptions sent to compliance staff.'),
    ],
  },
  healthcare: {
    id: 'healthcare',
    label: 'Healthcare',
    phrase: 'healthcare',
    aliases: ['clinic', 'dental practice', 'physiotherapy', 'care provider', 'private healthcare'],
    searchQueries: ['how UK private clinics and dental practices use AI automation', 'AI patient admin automation clinic case study UK'],
    patterns: [
      p('healthcare.booking', 'Booking and appointment reminders', 'ai-automation',
        'Patients book, move and cancel by message or online, reminders go out automatically, and freed slots are offered to people on a waiting list.'),
      p('healthcare.patient-intake', 'Patient intake and forms', 'ai-automation',
        'History and consent forms are completed before the visit, then read and summarised for the clinician, with anything urgent flagged.'),
      p('healthcare.clinical-notes', 'Drafting clinical notes and letters', 'ai-agent-development',
        'Consultations are transcribed and turned into draft notes and referral letters for the clinician to correct and sign, instead of typing them after hours.'),
      p('healthcare.claims-billing', 'Insurance claims and billing', 'ai-automation',
        'Treatment codes and insurer requirements are checked before claims go in, and rejected claims are sorted by reason for staff to resubmit.'),
      p('healthcare.message-triage', 'Triage of patient messages', 'ai-agent-development',
        'Patient messages are sorted by type and urgency, routine requests answered from approved templates, and clinical questions passed to staff.'),
      p('healthcare.rotas', 'Staff rotas and cover', 'ai-development-services',
        'Shift patterns, leave and skills are matched to demand, with gaps flagged early and cover requests sent out for a manager to approve.'),
    ],
  },
  'construction-trades': {
    id: 'construction-trades',
    label: 'Construction and trades',
    phrase: 'construction and trades',
    aliases: ['builders', 'contractors', 'electricians', 'plumbers', 'facilities management'],
    searchQueries: ['how UK construction firms and trades use AI automation', 'AI quoting and scheduling for builders and contractors UK'],
    patterns: [
      p('construction-trades.quotes', 'Turning site visits into quotes', 'ai-automation',
        'Notes, photos and measurements from a site visit become a draft quote from the firm’s own price list, for the estimator to check before it is sent.'),
      p('construction-trades.tenders', 'Reading tender documents', 'ai-agent-development',
        'Tender packs are read and summarised, with scope, deadlines, risks and required documents pulled out, so the team can decide quickly whether to bid.'),
      p('construction-trades.job-scheduling', 'Scheduling jobs and engineers', 'ai-development-services',
        'Jobs are allocated by location, skills and availability, customers get arrival updates, and the day is reshuffled when a job overruns.'),
      p('construction-trades.job-sheets', 'Site paperwork and job sheets', 'ai-automation',
        'Job sheets, timesheets and site photos captured on phones are read and filed against the job, ready for invoicing without re-keying.'),
      p('construction-trades.rams', 'Risk assessments and method statements', 'ai-agent-development',
        'First drafts of risk assessments and method statements are built from the job details and the firm’s past documents, for a competent person to review.'),
      p('construction-trades.invoice-matching', 'Matching supplier invoices to jobs', 'ai-automation',
        'Supplier invoices and delivery notes are read, matched to purchase orders and jobs, and mismatches flagged before anything is paid.'),
    ],
  },
  manufacturing: {
    id: 'manufacturing',
    label: 'Manufacturing',
    phrase: 'manufacturing',
    aliases: ['manufacturer', 'engineering firm', 'factory', 'fabrication', 'production'],
    searchQueries: ['how UK manufacturers use AI automation', 'AI in small manufacturing firms case study UK'],
    patterns: [
      p('manufacturing.order-entry', 'Entering customer orders', 'ai-automation',
        'Orders arriving by email or as attachments are read and entered into the order system, with unusual quantities, prices or part numbers flagged for checking.'),
      p('manufacturing.custom-quotes', 'Quoting custom parts', 'ai-agent-development',
        'Drawings and specifications are read, similar past jobs found, and a draft quote prepared from materials and machine time for an estimator to approve.'),
      p('manufacturing.quality-records', 'Making sense of quality records', 'ai-development-services',
        'Inspection results, photos and non-conformance reports are logged and grouped, so recurring faults and their likely causes surface sooner.'),
      p('manufacturing.maintenance', 'Planning maintenance from machine data', 'ai-development-services',
        'Machine readings and maintenance logs are watched for early signs of wear, and work orders suggested before a breakdown stops the line.'),
      p('manufacturing.supplier-documents', 'Supplier documents and certificates', 'ai-automation',
        'Certificates of conformity, delivery notes and supplier invoices are read, checked against orders and filed, with gaps chased automatically.'),
      p('manufacturing.technical-questions', 'Answering technical product questions', 'ai-agent-development',
        'An assistant answers sales and customer questions from datasheets, manuals and past answers, passing anything unusual to an engineer.'),
    ],
  },
  logistics: {
    id: 'logistics',
    label: 'Logistics',
    phrase: 'logistics',
    aliases: ['freight forwarding', 'haulage', 'courier', 'warehousing', 'supply chain'],
    searchQueries: ['how UK logistics and haulage firms use AI automation', 'AI freight forwarding automation case study UK'],
    patterns: [
      p('logistics.shipping-documents', 'Processing shipping documents', 'ai-automation',
        'Bills of lading, invoices and customs paperwork are read, key details extracted and checked against bookings, with discrepancies flagged before they cause delays.'),
      p('logistics.quote-requests', 'Responding to freight quote requests', 'ai-automation',
        'Quote requests are read, routes and rates looked up, and a draft quote prepared for the team to check and send, so fewer requests sit waiting.'),
      p('logistics.tracking-queries', 'Answering where-is-my-delivery questions', 'ai-automation',
        'Status questions are answered from tracking data automatically, and only real exceptions such as delays or damage reach a person.'),
      p('logistics.proof-of-delivery', 'Proof of delivery and exceptions', 'ai-automation',
        'Delivery photos, signatures and driver notes are checked and filed, with failed or disputed deliveries raised for follow-up.'),
      p('logistics.carrier-invoices', 'Checking carrier invoices', 'ai-automation',
        'Carrier invoices are compared with agreed rates and actual shipments, and overcharges or duplicates flagged for the finance team.'),
      p('logistics.load-planning', 'Load and route planning', 'ai-development-services',
        'Orders, vehicle capacity and delivery windows are combined into suggested loads and routes, for a planner to adjust and approve.'),
    ],
  },
  'ecommerce-retail': {
    id: 'ecommerce-retail',
    label: 'Ecommerce and retail',
    phrase: 'ecommerce and retail',
    aliases: ['online shop', 'ecommerce', 'retailer', 'direct to consumer brand', 'marketplace seller'],
    searchQueries: ['how UK online retailers use AI automation', 'AI customer service automation ecommerce case study UK'],
    patterns: [
      p('ecommerce-retail.customer-service', 'Handling customer service emails', 'ai-automation',
        'Questions about orders, returns and delivery are answered from order data and store policies, with refunds and complaints passed to a person.'),
      p('ecommerce-retail.product-content', 'Writing product descriptions', 'ai-automation',
        'Product titles, descriptions and attributes are drafted from supplier data and photos in the brand’s voice, then checked before going live.'),
      p('ecommerce-retail.returns', 'Processing returns and refunds', 'ai-automation',
        'Return requests are checked against the policy and order history, labels issued and refunds queued, with unusual patterns flagged for review.'),
      p('ecommerce-retail.stock-forecasting', 'Forecasting stock and reorders', 'ai-development-services',
        'Sales history, seasonality and supplier lead times feed suggested reorder quantities, so buyers review a list instead of building it.'),
      p('ecommerce-retail.feedback-themes', 'Finding themes in reviews and feedback', 'ai-automation',
        'Reviews, return reasons and support tickets are grouped into themes, so product and service problems are spotted from evidence rather than anecdote.'),
      p('ecommerce-retail.supplier-data', 'Cleaning supplier product data', 'ai-automation',
        'Supplier feeds in different formats are mapped to the store’s categories and attributes, with gaps and errors flagged before products are listed.'),
    ],
  },
  'hospitality-travel': {
    id: 'hospitality-travel',
    label: 'Hospitality and travel',
    phrase: 'hospitality and travel',
    aliases: ['hotel', 'restaurant', 'travel agency', 'tour operator', 'events venue'],
    searchQueries: ['how UK hotels and restaurants use AI automation', 'AI tools for travel and hospitality businesses case study UK'],
    patterns: [
      p('hospitality-travel.booking-enquiries', 'Handling booking enquiries', 'ai-automation',
        'Availability, prices and common questions are answered by message at any hour, with group and special requests passed to staff with the details captured.'),
      p('hospitality-travel.itineraries', 'Building itineraries and event proposals', 'ai-agent-development',
        'Client preferences and supplier options are pulled into a draft itinerary or event proposal, for a consultant to refine and price.'),
      p('hospitality-travel.review-replies', 'Responding to guest reviews', 'ai-automation',
        'Review replies are drafted in the venue’s voice, recurring complaints grouped into themes, and serious issues flagged for a manager.'),
      p('hospitality-travel.supplier-invoices', 'Supplier invoices and stock', 'ai-automation',
        'Supplier invoices are read and matched to orders, price changes flagged, and stock levels updated without re-keying.'),
      p('hospitality-travel.rotas', 'Staff rotas against demand', 'ai-development-services',
        'Bookings, events and past trading are used to suggest staffing levels and rotas, for a manager to adjust and publish.'),
      p('hospitality-travel.changes', 'Managing changes and cancellations', 'ai-agent-development',
        'Change and cancellation requests are checked against booking terms and supplier rules, with options drafted for staff to confirm with the customer.'),
    ],
  },
  'education-training': {
    id: 'education-training',
    label: 'Education and training',
    phrase: 'education and training',
    aliases: ['school', 'college', 'university', 'training provider', 'online courses'],
    searchQueries: ['how UK training providers and colleges use AI automation', 'AI admin automation education case study UK'],
    patterns: [
      p('education-training.enquiries', 'Answering admissions and course enquiries', 'ai-automation',
        'Questions about courses, fees, dates and entry requirements are answered from approved information, with applicant details captured for the admissions team.'),
      p('education-training.feedback', 'Drafting feedback on written work', 'ai-agent-development',
        'Draft feedback on assignments is produced against the marking criteria for a tutor to edit, so more of their time goes on the judgement calls.'),
      p('education-training.course-content', 'Turning material into course content', 'ai-agent-development',
        'Existing notes, slides and recordings are turned into draft lessons, quizzes and summaries for subject experts to check and approve.'),
      p('education-training.learner-records', 'Enrolment and learner records', 'ai-automation',
        'Enrolment forms, evidence and attendance are read, checked and updated in the learner record, with missing items chased automatically.'),
      p('education-training.funding-evidence', 'Funding and compliance evidence', 'ai-automation',
        'Learner evidence is checked against funding and awarding body requirements, with gaps flagged before an audit rather than during one.'),
      p('education-training.learner-support', 'Answering learner support questions', 'ai-automation',
        'An assistant answers routine questions about deadlines, access and course materials, passing welfare and academic concerns to staff.'),
    ],
  },
  agencies: {
    id: 'agencies',
    label: 'Agencies and consultancies',
    phrase: 'agencies and consultancies',
    aliases: ['marketing agency', 'digital agency', 'creative agency', 'pr agency', 'consultancy'],
    searchQueries: ['how UK marketing agencies and consultancies use AI automation', 'AI tools for digital agencies case study UK'],
    patterns: [
      p('agencies.proposals', 'Turning briefs into proposals', 'ai-agent-development',
        'Client briefs and discovery notes are turned into a first-draft proposal or scope of work in the agency template, for the account lead to shape and price.'),
      p('agencies.client-reporting', 'Client performance reporting', 'ai-automation',
        'Data from ad, analytics and social platforms is pulled together and a plain-language commentary drafted, so account teams review reports instead of building them.'),
      p('agencies.content-drafts', 'First drafts of client content', 'ai-automation',
        'First drafts of posts, articles and ad variations are produced from the client’s brand guidelines and past work, for writers to edit.'),
      p('agencies.project-profitability', 'Timesheets and project profitability', 'ai-automation',
        'Time, budgets and invoices are tracked against each project, with overruns flagged early instead of discovered at month end.'),
      p('agencies.meeting-actions', 'Meeting notes and action tracking', 'ai-automation',
        'Client calls are transcribed, decisions and actions summarised, and tasks created in the project tool for the team to confirm.'),
      p('agencies.prospect-research', 'Researching prospects before a pitch', 'ai-agent-development',
        'Public information about a prospect is gathered and summarised before a pitch, so the team walks in knowing the client’s situation.'),
    ],
  },
  'software-saas': {
    id: 'software-saas',
    label: 'Software and SaaS',
    phrase: 'software and SaaS',
    aliases: ['software company', 'saas', 'app developer', 'tech startup', 'platform business'],
    searchQueries: ['how UK SaaS companies use AI automation in support and operations', 'AI features added to SaaS products case study'],
    patterns: [
      p('software-saas.ticket-triage', 'Support ticket triage and first replies', 'ai-agent-development',
        'Tickets are classified, answered from documentation where possible, and routed with a summary when they need an engineer or account manager.'),
      p('software-saas.onboarding', 'Customer onboarding and setup', 'ai-automation',
        'New customers are guided through setup with answers drawn from the product documentation, and accounts that stall are flagged for the success team.'),
      p('software-saas.in-product-ai', 'AI features inside the product', 'ai-development-services',
        'Assistants, search or summaries are built into the product itself, where they help customers finish a core task with less effort.'),
      p('software-saas.documentation', 'Keeping documentation up to date', 'ai-automation',
        'Release notes, help articles and internal docs are drafted from code changes and tickets, for the team to check before publishing.'),
      p('software-saas.account-risk', 'Spotting accounts at risk', 'ai-development-services',
        'Usage data, support history and renewal dates are combined into early warnings, with suggested next steps for the account team.'),
      p('software-saas.questionnaires', 'Answering due diligence questionnaires', 'ai-agent-development',
        'Supplier questionnaires and tender questions are answered in draft from past responses and product documentation, for the relevant owner to check.'),
    ],
  },
  nonprofit: {
    id: 'nonprofit',
    label: 'Charities and nonprofits',
    phrase: 'charities and nonprofits',
    aliases: ['charity', 'non-profit', 'foundation', 'social enterprise', 'membership organisation'],
    searchQueries: ['how UK charities use AI automation', 'AI tools for charities and nonprofits case study UK'],
    patterns: [
      p('nonprofit.grant-writing', 'Drafting grant applications and reports', 'ai-agent-development',
        'Funder requirements are read and draft applications or impact reports assembled from existing material, for staff to tailor and check.'),
      p('nonprofit.supporter-questions', 'Answering supporter and member questions', 'ai-automation',
        'Routine questions about donations, events and membership are answered from approved information, with sensitive conversations passed to a person.'),
      p('nonprofit.supporter-records', 'Cleaning supporter records', 'ai-automation',
        'Duplicate and incomplete supporter records are found and merged, and gift aid details checked, so the database can be trusted.'),
      p('nonprofit.casework-triage', 'Triage of requests for help', 'ai-agent-development',
        'Requests from people seeking help are sorted by need and urgency, with the key facts summarised for a caseworker to pick up.'),
      p('nonprofit.volunteers', 'Volunteer scheduling and messages', 'ai-automation',
        'Volunteer availability, skills and shifts are matched, reminders sent and gaps flagged, so coordinators spend less time on messages.'),
      p('nonprofit.impact-evidence', 'Collecting and summarising impact evidence', 'ai-automation',
        'Feedback forms, case notes and attendance records are grouped and summarised into evidence of outcomes for trustees and funders.'),
    ],
  },
};

/** Patterns for `other`: common back-office work in any business. */
export const GENERIC_PATTERNS: IndustryPattern[] = [
  p('other.shared-inbox', 'Sorting and answering the shared inbox', 'ai-automation',
    'Incoming emails and form submissions are sorted by type, routine ones answered from approved templates, and the rest routed to the right person with a summary.'),
  p('other.document-data', 'Pulling details out of documents', 'ai-automation',
    'Invoices, forms and other documents are read and the key details entered into the systems the team already uses, with anything unclear flagged.'),
  p('other.internal-reporting', 'Building regular internal reports', 'ai-automation',
    'Data from several tools is pulled together on a schedule and a short written summary drafted, so someone reviews the report rather than assembling it.'),
  p('other.staff-questions', 'Answering staff questions from internal documents', 'ai-agent-development',
    'An assistant answers staff questions from policies, procedures and past work, pointing to the source, so fewer questions interrupt senior people.'),
  p('other.meeting-follow-ups', 'Meeting notes and follow-ups', 'ai-automation',
    'Calls and meetings are transcribed, actions summarised and follow-up emails drafted for the organiser to check and send.'),
];

export const INDUSTRY_IDS = Object.keys(INDUSTRIES) as IndustryId[];

export const isIndustryId = (id: unknown): id is IndustryId => typeof id === 'string' && Object.hasOwn(INDUSTRIES, id);

/**
 * An industry name for use mid-sentence: the playbook phrase for a known id; otherwise the given
 * label with its first letter lowercased, unless it starts with an acronym ("UK", "IT").
 */
export const industryPhrase = (id: unknown, label = ''): string => {
  if (isIndustryId(id)) return INDUSTRIES[id].phrase;
  const l = label.trim();
  return l && !/^\p{Lu}\p{Lu}/u.test(l) ? l.charAt(0).toLowerCase() + l.slice(1) : l;
};

/** Patterns for a resolved industry: its own, or the generic set for `other`. */
export const patternsFor = (id: IndustryChoice): readonly IndustryPattern[] =>
  id === OTHER_INDUSTRY ? GENERIC_PATTERNS : INDUSTRIES[id].patterns;

const PATTERN_INDEX: ReadonlyMap<string, IndustryPattern> = new Map(
  [...INDUSTRY_IDS.flatMap((id) => INDUSTRIES[id].patterns), ...GENERIC_PATTERNS].map((pt) => [pt.id, pt]),
);

/** Any pattern by id (all industries plus the generic set). */
export const findPattern = (id: string): IndustryPattern | undefined => PATTERN_INDEX.get(id);

/** Every pattern, all industries plus the generic set. */
export const ALL_PATTERNS: readonly IndustryPattern[] = [...PATTERN_INDEX.values()];
