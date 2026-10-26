import type {
  Account, Contact, Product, Contract, Opportunity, Subscription, Invoice, Payment,
  CreditMemo, Document, Communication, JiraIssue, Line,
} from "./types.ts";

// The seller is Miny Labs, Inc., a US B2B SaaS company. Peeblo owns its US receivables.
// "Today" for the seeded world. Every relative date is anchored here.
export const TODAY = "2026-09-14";
export const SELLER = {
  name: "Miny Labs, Inc.",
  address: "548 Market St, Suite 400, San Francisco, CA 94104",
  arEmail: "ar@minylabs.com",
  ein: "93-1847722",
  remitTo: "Miny Labs, Inc. — First Republic Bank, ACH routing 321081669, acct ****4410",
};

export const PRODUCTS: Product[] = [
  { key: "seat_annual", name: "Miny Platform Seat (annual)", sku: "PLAT-SEAT-A", unitAmount: 1200, unit: "seat/year", recurring: "year", qboIncomeAccount: "Subscription Revenue" },
  { key: "seat_monthly", name: "Miny Platform Seat (monthly)", sku: "PLAT-SEAT-M", unitAmount: 110, unit: "seat/month", recurring: "month", qboIncomeAccount: "Subscription Revenue" },
  { key: "premium_support", name: "Premium Support (annual)", sku: "SUP-PREM", unitAmount: 5000, unit: "year", recurring: "year", qboIncomeAccount: "Support Revenue" },
  { key: "api_overage", name: "API Overage (per 1,000 calls)", sku: "API-OVG", unitAmount: 0.4, unit: "1,000 calls", qboIncomeAccount: "Usage Revenue" },
  { key: "implementation", name: "Implementation Services", sku: "SVC-IMPL", unitAmount: 12000, unit: "project", qboIncomeAccount: "Services Revenue" },
  { key: "training", name: "Admin Training Session", sku: "SVC-TRN", unitAmount: 1800, unit: "session", qboIncomeAccount: "Services Revenue" },
  { key: "platform_flat_monthly", name: "Miny Platform Subscription (network plan, monthly)", sku: "PLAT-NET-M", unitAmount: 8000, unit: "month", recurring: "month", qboIncomeAccount: "Subscription Revenue" },
];

export const lineTotal = (lines: Line[]) => Math.round(lines.reduce((s, l) => s + l.quantity * l.unitAmount, 0) * 100) / 100;

// ---------------------------------------------------------------------------------------------
// Accounts. Case accounts first, then lookalikes, then healthy background accounts.
// ---------------------------------------------------------------------------------------------
type A = Omit<Account, "industry" | "segment" | "crm" | "stripe" | "qbo" | "city" | "state" | "paymentTerms"> & Partial<Account>;
const acct = (a: A): Account => ({
  industry: "Software", segment: "mid_market", crm: "hubspot", stripe: true, qbo: true,
  city: "San Francisco", state: "CA", paymentTerms: "Net 30", ...a,
});

const CASE_ACCOUNTS: Account[] = [
  acct({ key: "eastbridge_holdings", name: "Eastbridge Holdings", legalName: "Eastbridge Holdings, Inc.", domain: "eastbridge.com", industry: "Logistics", segment: "enterprise", crm: "salesforce", city: "Chicago", state: "IL", taxId: "36-4418207", notes: "Parent company. Holds its own 20-seat subscription." }),
  acct({ key: "eastbridge_logistics", name: "Eastbridge Logistics", legalName: "Eastbridge Logistics LLC", domain: "eastbridgelogistics.com", parentKey: "eastbridge_holdings", industry: "Logistics", segment: "enterprise", crm: "both", stripe: false, city: "Joliet", state: "IL", taxId: "84-2917365", notes: "Separate legal entity and separate AP department from its parent." }),
  acct({ key: "pinecrest_analytics", name: "Pinecrest Analytics", legalName: "Pinecrest Analytics, Inc.", domain: "pinecrestanalytics.io", crm: "salesforce", stripe: false, qbo: false, city: "Denver", state: "CO" }),
  acct({ key: "halcyon_bio", name: "Halcyon Bio", legalName: "Halcyon Biosciences, Inc.", domain: "halcyonbio.com", industry: "Biotech", crm: "salesforce", stripe: false, qbo: false, city: "Cambridge", state: "MA", paymentTerms: "Net 45" }),
  acct({ key: "quarry_labs", name: "Quarry Labs", legalName: "Quarry Labs Inc.", domain: "quarrylabs.dev", segment: "smb", city: "Austin", state: "TX", paymentTerms: "Net 15" }),
  acct({ key: "meridian_health", name: "Meridian Health System", legalName: "Meridian Health System", domain: "meridianhealth.org", industry: "Healthcare", segment: "enterprise", crm: "salesforce", city: "Columbus", state: "OH", paymentTerms: "Net 60", poRequired: true }),
  acct({ key: "falcon_aerospace", name: "Falcon Aerospace", legalName: "Falcon Aerospace Corp.", domain: "falconaero.com", industry: "Aerospace", segment: "enterprise", crm: "salesforce", city: "Wichita", state: "KS", paymentTerms: "Net 45", poRequired: true }),
  acct({ key: "tidewater_energy", name: "Tidewater Energy", legalName: "Tidewater Energy Partners LP", domain: "tidewaterenergy.com", industry: "Energy", segment: "enterprise", crm: "salesforce", city: "Houston", state: "TX" }),
  acct({ key: "solstice_media", name: "Solstice Media", legalName: "Solstice Media Co.", domain: "solsticemedia.co", industry: "Media", segment: "smb", city: "Los Angeles", state: "CA", paymentTerms: "Due on receipt" }),
  acct({ key: "harbor_pine", name: "Harbor & Pine", legalName: "Harbor & Pine Outfitters LLC", domain: "harborandpine.com", industry: "Retail", stripe: false, city: "Portland", state: "ME" }),
  acct({ key: "copperleaf_supply", name: "Copperleaf Supply", legalName: "Copperleaf Supply Co.", domain: "copperleafsupply.com", industry: "Wholesale", stripe: false, city: "Minneapolis", state: "MN" }),
  acct({ key: "brightline_studios", name: "Brightline Studios", legalName: "Brightline Studios Inc.", domain: "brightlinestudios.tv", industry: "Media", segment: "smb", city: "Atlanta", state: "GA", paymentTerms: "Net 15" }),
  acct({ key: "crescent_dental", name: "Crescent Dental Group", legalName: "Crescent Dental Group, PC", domain: "crescentdental.com", industry: "Healthcare", stripe: false, city: "Phoenix", state: "AZ" }),
  acct({ key: "cdg_partners", name: "CDG Partners LLC", legalName: "CDG Partners LLC", domain: "cdgpartners.com", industry: "Healthcare", crm: "none", stripe: false, city: "Phoenix", state: "AZ", notes: "Created in QuickBooks by the bookkeeper when an ACH deposit arrived. Not a CRM account." }),
  acct({ key: "ridgeview_usd", name: "Ridgeview Unified School District", legalName: "Ridgeview Unified School District", domain: "ridgeviewusd.org", industry: "Education", stripe: false, city: "Sacramento", state: "CA", paymentTerms: "Net 45" }),
  acct({ key: "ridgeview_capital", name: "Ridgeview Capital", legalName: "Ridgeview Capital Management LLC", domain: "ridgeviewcap.com", industry: "Financial Services", segment: "smb", stripe: false, city: "New York", state: "NY" }),
  acct({ key: "northwind_group", name: "Northwind Group", legalName: "Northwind Group Holdings, Inc.", domain: "northwindgroup.com", industry: "Conglomerate", segment: "enterprise", crm: "salesforce", stripe: false, city: "Seattle", state: "WA" }),
  acct({ key: "northwind_retail", name: "Northwind Retail", legalName: "Northwind Retail LLC", domain: "northwindretail.com", parentKey: "northwind_group", industry: "Retail", segment: "enterprise", crm: "salesforce", stripe: false, city: "Tacoma", state: "WA" }),
  acct({ key: "northwind_health", name: "Northwind Health", legalName: "Northwind Health Services LLC", domain: "northwindhealth.com", parentKey: "northwind_group", industry: "Healthcare", segment: "enterprise", crm: "salesforce", stripe: false, city: "Bellevue", state: "WA" }),
  acct({ key: "vantage_robotics", name: "Vantage Robotics", legalName: "Vantage Robotics, Inc.", domain: "vantagerobotics.ai", industry: "Robotics", crm: "both", city: "Pittsburgh", state: "PA" }),
  acct({ key: "lumen_clinics", name: "Lumen Clinics", legalName: "Lumen Clinics Network, PLLC", domain: "lumenclinics.com", industry: "Healthcare", crm: "salesforce", city: "Nashville", state: "TN" }),
  acct({ key: "orchid_legal", name: "Orchid Legal", legalName: "Orchid Legal LLP", domain: "orchidlegal.com", industry: "Legal", segment: "smb" }),
  acct({ key: "sequoia_freight", name: "Sequoia Freight", legalName: "Sequoia Freight Lines, Inc.", domain: "sequoiafreight.com", industry: "Logistics", crm: "both", stripe: false, city: "Fresno", state: "CA" }),
  acct({ key: "keystone_apparel", name: "Keystone Apparel", legalName: "Keystone Apparel Group LLC", domain: "keystoneapparel.com", industry: "Retail", segment: "smb", city: "Philadelphia", state: "PA", paymentTerms: "Due on receipt" }),
  acct({ key: "beacon_schools", name: "Beacon Schools", legalName: "Beacon Charter Schools Network", domain: "beaconschools.org", industry: "Education", city: "Denver", state: "CO" }),
  acct({ key: "atlas_pharma", name: "Atlas Pharma", legalName: "Atlas Pharma US, Inc.", domain: "atlaspharma.com", industry: "Pharmaceuticals", segment: "enterprise", crm: "salesforce", city: "Raleigh", state: "NC", paymentTerms: "Net 45", taxId: "56-2290714" }),
  acct({ key: "kestrel_foods", name: "Kestrel Foods", legalName: "Kestrel Foods Corporation", domain: "kestrelfoods.com", industry: "Food & Beverage", segment: "enterprise", crm: "salesforce", stripe: false, city: "Omaha", state: "NE", paymentTerms: "Net 45" }),
  acct({ key: "orion_dental", name: "Orion Dental Labs", legalName: "Orion Dental Laboratories LLC", domain: "oriondentallabs.com", industry: "Healthcare", segment: "smb", stripe: false, city: "Tampa", state: "FL" }),
];

// Name lookalikes and rename history. None of these have open problems.
const LOOKALIKE_ACCOUNTS: Account[] = [
  acct({ key: "east_bridge_coffee", name: "East Bridge Coffee Roasters", legalName: "East Bridge Coffee Roasters LLC", domain: "eastbridgecoffee.com", industry: "Food & Beverage", segment: "smb", city: "Milwaukee", state: "WI", paymentTerms: "Due on receipt" }),
  acct({ key: "acme_corporation", name: "ACME Corporation", legalName: "ACME Corporation", domain: "acmecorp.com", industry: "Manufacturing", segment: "enterprise", crm: "salesforce", city: "Detroit", state: "MI" }),
  acct({ key: "acme_robotics", name: "Acme Robotics", legalName: "Acme Robotics Inc.", domain: "acmerobotics.io", industry: "Robotics", segment: "smb", city: "San Jose", state: "CA" }),
  acct({ key: "globex_systems", name: "Globex Systems", legalName: "Globex Systems, Inc.", domain: "globex.com", crm: "both", renamedFrom: "Globex Corporation", city: "Springfield", state: "IL", notes: "Renamed from Globex Corporation in June 2026; same legal EIN." }),
  acct({ key: "northwind_traders", name: "Northwind Traders", legalName: "Northwind Traders Co.", domain: "northwindtraders.com", industry: "Wholesale", segment: "smb", city: "Boise", state: "ID", notes: "Unrelated to Northwind Group." }),
  acct({ key: "meridian_capital", name: "Meridian Capital Advisors", legalName: "Meridian Capital Advisors LLC", domain: "meridiancap.com", industry: "Financial Services", segment: "smb", city: "Boston", state: "MA", notes: "Unrelated to Meridian Health System." }),
];

const HEALTHY_SPECS: [key: string, name: string, legal: string, domain: string, industry: string, segment: Account["segment"], crm: Account["crm"], city: string, state: string, seats: number][] = [
  ["brightwave_ai", "Brightwave AI", "Brightwave AI, Inc.", "brightwave.ai", "Software", "smb", "hubspot", "Oakland", "CA", 8],
  ["cobalt_insurance", "Cobalt Insurance", "Cobalt Mutual Insurance Co.", "cobaltinsure.com", "Insurance", "enterprise", "salesforce", "Hartford", "CT", 120],
  ["driftwood_hospitality", "Driftwood Hospitality", "Driftwood Hospitality Group LLC", "driftwoodhg.com", "Hospitality", "mid_market", "hubspot", "Charleston", "SC", 35],
  ["evergreen_credit_union", "Evergreen Credit Union", "Evergreen Federal Credit Union", "evergreencu.org", "Financial Services", "mid_market", "salesforce", "Spokane", "WA", 45],
  ["fjord_logistics", "Fjord Logistics", "Fjord Logistics Inc.", "fjordlogistics.com", "Logistics", "mid_market", "both", "Anchorage", "AK", 28],
  ["granite_legal", "Granite Legal", "Granite Legal Partners LLP", "granitelegal.com", "Legal", "smb", "hubspot", "Manchester", "NH", 12],
  ["helix_genomics", "Helix Genomics", "Helix Genomics Corp.", "helixgenomics.com", "Biotech", "enterprise", "salesforce", "San Diego", "CA", 90],
  ["ironclad_security", "Ironclad Security", "Ironclad Security Services Inc.", "ironcladsec.com", "Security", "mid_market", "hubspot", "Arlington", "VA", 40],
  ["juniper_schools", "Juniper Schools", "Juniper Academies Foundation", "juniperschools.org", "Education", "mid_market", "hubspot", "Salt Lake City", "UT", 30],
  ["kinetic_motors", "Kinetic Motors", "Kinetic Motors Holdings, Inc.", "kineticmotors.com", "Automotive", "enterprise", "salesforce", "Fremont", "CA", 150],
  ["lighthouse_realty", "Lighthouse Realty", "Lighthouse Realty Group LLC", "lighthouserealty.com", "Real Estate", "smb", "hubspot", "Miami", "FL", 10],
  ["monarch_foods", "Monarch Foods", "Monarch Foods Company", "monarchfoods.com", "Food & Beverage", "enterprise", "salesforce", "Kansas City", "MO", 80],
  ["nimbus_cloud", "Nimbus Cloud", "Nimbus Cloud Services Ltd.", "nimbuscloud.io", "Software", "mid_market", "both", "Seattle", "WA", 55],
  ["opal_wellness", "Opal Wellness", "Opal Wellness Clinics PLLC", "opalwellness.com", "Healthcare", "smb", "hubspot", "Scottsdale", "AZ", 14],
  ["prairie_ag", "Prairie Ag Cooperative", "Prairie Agricultural Cooperative", "prairieag.coop", "Agriculture", "mid_market", "salesforce", "Des Moines", "IA", 25],
  ["quantum_freight", "Quantum Freight", "Quantum Freight Systems Inc.", "quantumfreight.com", "Logistics", "mid_market", "hubspot", "Memphis", "TN", 32],
];

const HEALTHY_ACCOUNTS: Account[] = HEALTHY_SPECS.map(([key, name, legalName, domain, industry, segment, crm, city, state]) =>
  acct({ key, name, legalName, domain, industry, segment, crm, city, state, stripe: segment !== "enterprise", paymentTerms: segment === "enterprise" ? "Net 45" : "Net 30" }));

export const ACCOUNTS: Account[] = [...CASE_ACCOUNTS, ...LOOKALIKE_ACCOUNTS, ...HEALTHY_ACCOUNTS];

// ---------------------------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------------------------
type C = [key: string, accountKey: string, first: string, last: string, email: string, title: string, role: Contact["role"], crm?: Contact["crm"], status?: Contact["status"]];
const CONTACT_ROWS: C[] = [
  ["eb_h_cfo", "eastbridge_holdings", "Renata", "Voss", "renata.voss@eastbridge.com", "Chief Financial Officer", "exec"],
  ["eb_h_ap", "eastbridge_holdings", "Gary", "Lindqvist", "ap@eastbridge.com", "Accounts Payable Manager", "ap"],
  ["eb_h_champion", "eastbridge_holdings", "Olivia", "Park", "olivia.park@eastbridge.com", "VP Operations Technology", "champion"],
  ["eb_l_coo", "eastbridge_logistics", "Daniel", "Osei", "daniel.osei@eastbridgelogistics.com", "Chief Operating Officer", "exec", "salesforce"],
  ["eb_l_ap", "eastbridge_logistics", "Priya", "Natarajan", "priya.natarajan@eastbridgelogistics.com", "Accounts Payable Lead", "ap", "hubspot"],
  ["eb_l_champion", "eastbridge_logistics", "Sam", "Whitfield", "sam.whitfield@eastbridge.com", "Director, Fleet Systems", "champion", "salesforce"],
  ["pc_controller", "pinecrest_analytics", "Leah", "Fischer", "billing@pinecrestanalytics.io", "Controller", "billing"],
  ["pc_champion", "pinecrest_analytics", "Noah", "Brandt", "noah.brandt@pinecrestanalytics.io", "Head of Data Platform", "champion"],
  ["hb_champion", "halcyon_bio", "Mei", "Tanaka", "mei.tanaka@halcyonbio.com", "Director, Lab Informatics", "champion"],
  ["hb_exec", "halcyon_bio", "Arjun", "Mehta", "arjun.mehta@halcyonbio.com", "Chief Scientific Officer", "exec"],
  ["ql_founder", "quarry_labs", "Tess", "Morales", "tess@quarrylabs.dev", "Co-founder & CEO", "exec"],
  ["ql_billing", "quarry_labs", "Ben", "Okafor", "finance@quarrylabs.dev", "Finance Manager", "billing"],
  ["mh_procurement", "meridian_health", "Gloria", "Hendricks", "gloria.hendricks@meridianhealth.org", "Senior Procurement Specialist", "procurement"],
  ["mh_ap", "meridian_health", "Accounts", "Payable", "accountspayable@meridianhealth.org", "AP Shared Mailbox", "ap"],
  ["mh_champion", "meridian_health", "Dr. Kevin", "Achebe", "kevin.achebe@meridianhealth.org", "CMIO", "champion"],
  ["fa_procurement", "falcon_aerospace", "Rick", "Dunmore", "rick.dunmore@falconaero.com", "Procurement Manager", "procurement"],
  ["fa_ap", "falcon_aerospace", "Janet", "Kowalski", "ap@falconaero.com", "AP Supervisor", "ap"],
  ["te_ap", "tidewater_energy", "Luis", "Carrillo", "luis.carrillo@tidewaterenergy.com", "Accounts Payable Analyst", "ap"],
  ["te_champion", "tidewater_energy", "Hannah", "Greer", "hannah.greer@tidewaterenergy.com", "Director, Digital Operations", "champion"],
  ["te_billing_new", "tidewater_energy", "Marisol", "Vega", "billing@tidewaterenergy.com", "Revenue Accounting Manager", "billing"],
  ["sm_owner", "solstice_media", "Jordan", "Blake", "jordan@solsticemedia.co", "Founder", "billing"],
  ["hp_ap", "harbor_pine", "Elena", "Rossi", "elena.rossi@harborandpine.com", "Controller", "ap"],
  ["cl_ap", "copperleaf_supply", "Doug", "Pruitt", "doug.pruitt@copperleafsupply.com", "Office Manager", "ap"],
  ["bl_ap", "brightline_studios", "Kira", "Shah", "kira@brightlinestudios.tv", "Studio Operations Manager", "billing"],
  ["cd_ap", "crescent_dental", "Monica", "Delgado", "billing@crescentdental.com", "Practice Finance Manager", "ap"],
  ["rv_usd_ap", "ridgeview_usd", "Warren", "Tully", "wtully@ridgeviewusd.org", "District Accounts Payable", "ap"],
  ["rv_cap_ap", "ridgeview_capital", "Sofia", "Lang", "sofia.lang@ridgeviewcap.com", "Operations Associate", "billing"],
  ["nw_group_treasury", "northwind_group", "Harold", "Beck", "treasury@northwindgroup.com", "Assistant Treasurer", "ap"],
  ["nw_retail_it", "northwind_retail", "Chloe", "Nguyen", "chloe.nguyen@northwindretail.com", "IT Director", "champion"],
  ["nw_health_it", "northwind_health", "Omar", "Haddad", "omar.haddad@northwindhealth.com", "Clinical Systems Lead", "champion"],
  ["vr_finance", "vantage_robotics", "Grace", "Liu", "grace.liu@vantagerobotics.ai", "VP Finance", "billing"],
  ["vr_eng", "vantage_robotics", "Felix", "Romero", "felix.romero@vantagerobotics.ai", "Platform Engineering Lead", "champion"],
  ["lc_ops", "lumen_clinics", "Dana", "Whitaker", "dana.whitaker@lumenclinics.com", "VP Clinical Operations", "exec"],
  ["lc_ap", "lumen_clinics", "Ivy", "Chambers", "ap@lumenclinics.com", "AP Coordinator", "ap"],
  ["ol_office", "orchid_legal", "Theo", "Marsh", "tmarsh@orchidlegal.com", "Office Administrator", "billing"],
  ["sf_ap_old", "sequoia_freight", "Tom", "Reyes", "tom.reyes@sequoiafreight.com", "AP Specialist", "ap", "hubspot", "left_company"],
  ["sf_ap_new", "sequoia_freight", "Carmen", "Ortiz", "carmen.ortiz@sequoiafreight.com", "Accounts Payable Manager", "ap", "salesforce"],
  ["ka_owner", "keystone_apparel", "Nate", "Russo", "nate@keystoneapparel.com", "Owner", "billing"],
  ["bs_finance", "beacon_schools", "Latoya", "Grant", "finance@beaconschools.org", "Network Finance Director", "billing"],
  ["ap_ap", "atlas_pharma", "Ingrid", "Bauer", "ap-us@atlaspharma.com", "AP Team Lead, US", "ap"],
  ["ap_champion", "atlas_pharma", "Victor", "Chen", "victor.chen@atlaspharma.com", "Head of R&D Informatics", "champion"],
  ["kf_ap", "kestrel_foods", "Paula", "Jensen", "paula.jensen@kestrelfoods.com", "AP Manager", "ap"],
  ["od_owner", "orion_dental", "Rafael", "Ortega", "rafael@oriondentallabs.com", "Owner", "billing"],
  ["ebc_owner", "east_bridge_coffee", "Molly", "Brennan", "molly@eastbridgecoffee.com", "Owner", "billing"],
  ["acme_corp_ap", "acme_corporation", "Walter", "Grimes", "ap@acmecorp.com", "AP Director", "ap"],
  ["acme_rob_ceo", "acme_robotics", "Yuki", "Sato", "yuki@acmerobotics.io", "CEO", "billing"],
  ["globex_ap", "globex_systems", "Hank", "Scorpio", "ap@globex.com", "Finance Lead", "ap"],
  ["nwt_owner", "northwind_traders", "Aaron", "Fuller", "aaron@northwindtraders.com", "Owner", "billing"],
  ["mca_ops", "meridian_capital", "Beth", "Carlisle", "beth.carlisle@meridiancap.com", "COO", "billing"],
];

const FIRST = ["Alex", "Morgan", "Riley", "Casey", "Jamie", "Taylor", "Jordan", "Avery", "Quinn", "Parker", "Reese", "Rowan", "Skyler", "Emerson", "Hayden", "Logan"];
const LAST = ["Nguyen", "Patel", "Garcia", "Kim", "Johnson", "Silva", "Cohen", "Okoro", "Larsen", "Moreau", "Ibrahim", "Novak", "Duarte", "Ferreira", "Walsh", "Kaur"];

export const CONTACTS: Contact[] = [
  ...CONTACT_ROWS.map(([key, accountKey, firstName, lastName, email, title, role, crm, status]): Contact => ({
    key, accountKey, firstName, lastName, email, title, role, status: status ?? "active",
    crm: crm ?? ACCOUNTS.find((a) => a.key === accountKey)!.crm,
  })),
  ...HEALTHY_ACCOUNTS.flatMap((a, i): Contact[] => [
    { key: `${a.key}_billing`, accountKey: a.key, firstName: FIRST[i], lastName: LAST[i], email: `billing@${a.domain}`, title: "Finance Manager", role: "billing", crm: a.crm, status: "active" },
    { key: `${a.key}_champion`, accountKey: a.key, firstName: FIRST[(i + 5) % 16], lastName: LAST[(i + 9) % 16], email: `${FIRST[(i + 5) % 16].toLowerCase()}@${a.domain}`, title: "Operations Director", role: "champion", crm: a.crm, status: "active" },
  ]),
];

// ---------------------------------------------------------------------------------------------
// Contracts, opportunities, subscriptions
// ---------------------------------------------------------------------------------------------
const seat = (n: number, unit = 1200): Line => ({ productKey: "seat_annual", quantity: n, unitAmount: unit });
const seatM = (n: number, unit = 110): Line => ({ productKey: "seat_monthly", quantity: n, unitAmount: unit });
const support = (): Line => ({ productKey: "premium_support", quantity: 1, unitAmount: 5000 });
const impl = (amt = 12000): Line => ({ productKey: "implementation", quantity: 1, unitAmount: amt });
const training = (amt = 1800): Line => ({ productKey: "training", quantity: 1, unitAmount: amt });

const STD_CLAUSES = [
  "Fees are invoiced in advance and payable in US dollars within the payment terms stated above.",
  "Late balances may accrue interest at 1% per month after written notice.",
  "Customer may dispute an invoice in good faith by written notice within 30 days of receipt, stating the disputed amount and basis. Undisputed amounts remain payable.",
];

export const CONTRACTS: Contract[] = [
  { key: "c_eb_logistics_2026", accountKey: "eastbridge_logistics", title: "Order Form EBL-2026-01", status: "active", startDate: "2026-08-15", termMonths: 12, billing: "annual_upfront", lines: [seat(80), support()], paymentTerms: "Net 30", signedBy: "Daniel Osei, Chief Operating Officer, Eastbridge Logistics LLC", clauses: ["Customer: Eastbridge Logistics LLC, 2200 Channahon Rd, Joliet, IL 60436 (EIN 84-2917365).", "Invoices must be addressed to the Customer legal entity named above and sent to priya.natarajan@eastbridgelogistics.com. Invoices addressed to any other entity, including affiliates, will be rejected by Customer's accounts payable.", "This Order Form is governed by the Master Subscription Agreement between Miny Labs, Inc. and Eastbridge Holdings, Inc. dated September 1, 2025, which affiliates may use by signing their own Order Form.", ...STD_CLAUSES] },
  { key: "c_eb_holdings_2025", accountKey: "eastbridge_holdings", title: "Master Subscription Agreement and Order Form EBH-2025-01", status: "active", startDate: "2025-09-01", termMonths: 12, billing: "annual_upfront", lines: [seat(20)], paymentTerms: "Net 30", signedBy: "Renata Voss, Chief Financial Officer, Eastbridge Holdings, Inc.", clauses: ["Customer: Eastbridge Holdings, Inc., 150 N Riverside Plaza, Chicago, IL 60606 (EIN 36-4418207).", "Auto-renews for successive 12-month terms at the then-current fees unless either party gives 30 days' notice.", ...STD_CLAUSES] },
  { key: "c_pinecrest_2026", accountKey: "pinecrest_analytics", title: "Order Form PCA-2026-01", status: "active", startDate: "2026-09-01", termMonths: 12, billing: "annual_upfront", lines: [seat(40), impl()], paymentTerms: "Net 30", signedBy: "Noah Brandt, Head of Data Platform, Pinecrest Analytics, Inc.", clauses: ["Fees for the first year and Implementation Services are invoiced upon signature.", "Billing contact: Leah Fischer, Controller, billing@pinecrestanalytics.io.", ...STD_CLAUSES] },
  { key: "c_halcyon_2026", accountKey: "halcyon_bio", title: "Order Form HBI-2026-01", status: "active", startDate: "2026-09-15", termMonths: 12, billing: "annual_upfront", lines: [seat(30)], paymentTerms: "Net 45", signedBy: "Arjun Mehta, Chief Scientific Officer, Halcyon Biosciences, Inc.", clauses: ["Customer legal name: Halcyon Biosciences, Inc., 75 Binney St, Cambridge, MA 02142.", "Invoices to: Accounts Payable, ap@halcyonbio.com. Supplier must be registered in Customer's vendor system before the first invoice.", ...STD_CLAUSES] },
  { key: "c_quarry_2026", accountKey: "quarry_labs", title: "Renewal Order Form QL-2026", status: "active", startDate: "2026-09-15", termMonths: 12, billing: "annual_upfront", lines: [seat(30, 960)], discountPct: 20, paymentTerms: "Net 15", signedBy: "Tess Morales, CEO, Quarry Labs Inc.", clauses: ["Platform seats are priced at $960.00 per seat per year, reflecting a 20% multi-year discount off list price of $1,200.00, locked through September 14, 2028.", ...STD_CLAUSES] },
  { key: "c_meridian_2026", accountKey: "meridian_health", title: "Renewal Order Form MHS-2026", status: "active", startDate: "2026-10-01", termMonths: 12, billing: "annual_upfront", lines: [seat(150)], paymentTerms: "Net 60", poRequired: true, signedBy: "Dr. Kevin Achebe, CMIO, Meridian Health System", clauses: ["A valid Meridian purchase order number must appear on every invoice. Invoices without a PO number will be returned unpaid.", "Invoices are issued no earlier than 30 days before the renewal date.", ...STD_CLAUSES] },
  { key: "c_falcon_2026", accountKey: "falcon_aerospace", title: "Order Form FAC-2026-02", status: "active", startDate: "2026-09-01", termMonths: 12, billing: "annual_upfront", lines: [seat(60), support()], paymentTerms: "Net 45", poRequired: true, poNumber: "PO-FA-77812", signedBy: "Rick Dunmore, Procurement Manager, Falcon Aerospace Corp.", clauses: ["Invoices must reference Falcon Aerospace purchase order number and be submitted to ap@falconaero.com.", ...STD_CLAUSES] },
  { key: "c_tidewater_2026", accountKey: "tidewater_energy", title: "Order Form TWE-2026-01", status: "active", startDate: "2026-01-01", termMonths: 12, billing: "monthly", lines: [seatM(50)], paymentTerms: "Net 30", signedBy: "Hannah Greer, Director, Digital Operations, Tidewater Energy Partners LP", clauses: ["Seats are billed monthly in advance at $110.00 per seat.", "Seat additions take effect on the effective date stated in a signed amendment and are billed from that date."] },
  { key: "c_solstice_2026", accountKey: "solstice_media", title: "Self-serve subscription (card)", status: "active", startDate: "2026-03-01", termMonths: 1, billing: "monthly", lines: [seatM(12)], paymentTerms: "Due on receipt", signedBy: "Jordan Blake, Founder, Solstice Media Co. (click-through)", clauses: ["Charged automatically to the card on file each month. Failed payments are retried automatically."] },
  { key: "c_harbor_2026", accountKey: "harbor_pine", title: "Order Form HPO-2026", status: "active", startDate: "2026-07-01", termMonths: 12, billing: "annual_upfront", lines: [seat(14), training(1600)], paymentTerms: "Net 30", signedBy: "Elena Rossi, Controller, Harbor & Pine Outfitters LLC", clauses: STD_CLAUSES },
  { key: "c_copperleaf_2026", accountKey: "copperleaf_supply", title: "Order Form CLS-2026", status: "active", startDate: "2026-06-14", termMonths: 12, billing: "annual_upfront", lines: [seat(7), { productKey: "training", quantity: 1, unitAmount: 1350 }], paymentTerms: "Net 30", signedBy: "Doug Pruitt, Office Manager, Copperleaf Supply Co.", clauses: STD_CLAUSES },
  { key: "c_brightline_2026", accountKey: "brightline_studios", title: "Order Form BLS-2026", status: "active", startDate: "2026-07-22", termMonths: 12, billing: "annual_upfront", lines: [seat(5, 1240)], paymentTerms: "Net 15", signedBy: "Kira Shah, Studio Operations Manager, Brightline Studios Inc.", clauses: STD_CLAUSES },
  { key: "c_crescent_2026", accountKey: "crescent_dental", title: "Order Form CDG-2026", status: "active", startDate: "2026-07-28", termMonths: 12, billing: "annual_upfront", lines: [seat(10), { productKey: "training", quantity: 1, unitAmount: 600 }], paymentTerms: "Net 30", signedBy: "Monica Delgado, Practice Finance Manager, Crescent Dental Group, PC", clauses: ["Payments may be remitted by Customer's management services organization, CDG Partners LLC, on Customer's behalf.", ...STD_CLAUSES] },
  { key: "c_ridgeview_usd_2026", accountKey: "ridgeview_usd", title: "Order Form RUSD-2026", status: "active", startDate: "2026-08-01", termMonths: 12, billing: "annual_upfront", lines: [seat(6, 1250)], paymentTerms: "Net 45", signedBy: "Warren Tully, District Accounts Payable, Ridgeview Unified School District", clauses: ["District payments are issued by county warrant and reference the invoice number.", ...STD_CLAUSES] },
  { key: "c_ridgeview_cap_2026", accountKey: "ridgeview_capital", title: "Order Form RCM-2026", status: "active", startDate: "2026-08-03", termMonths: 12, billing: "annual_upfront", lines: [seat(6, 1250)], paymentTerms: "Net 30", signedBy: "Sofia Lang, Operations Associate, Ridgeview Capital Management LLC", clauses: STD_CLAUSES },
  { key: "c_northwind_2026", accountKey: "northwind_group", title: "Enterprise Agreement NWG-2026 (group and affiliates)", status: "active", startDate: "2026-08-05", termMonths: 12, billing: "annual_upfront", lines: [seat(15), seat(12, 1250), seat(6), { productKey: "training", quantity: 1, unitAmount: 1350 }], paymentTerms: "Net 30", signedBy: "Harold Beck, Assistant Treasurer, Northwind Group Holdings, Inc.", clauses: ["Affiliates Northwind Retail LLC (15 seats) and Northwind Health Services LLC (12 seats) are invoiced separately. Northwind Group Holdings, Inc. may pay affiliate invoices centrally.", "Admin Training Sessions are priced at $1,350.00 per session under this Agreement.", ...STD_CLAUSES] },
  { key: "c_vantage_2026", accountKey: "vantage_robotics", title: "Order Form VRI-2026 with Usage Schedule", status: "active", startDate: "2026-02-01", termMonths: 12, billing: "monthly", lines: [seatM(45)], overageCapMonthly: 2500, paymentTerms: "Net 30", signedBy: "Grace Liu, VP Finance, Vantage Robotics, Inc.", clauses: ["API usage above 5,000,000 calls per month is billed at $0.40 per 1,000 calls.", "Overage fees shall not exceed $2,500.00 in any calendar month.", ...STD_CLAUSES] },
  { key: "c_lumen_2026", accountKey: "lumen_clinics", title: "Network Plan Agreement LCN-2026 with SLA", status: "active", startDate: "2026-04-01", termMonths: 24, billing: "monthly", lines: [{ productKey: "platform_flat_monthly", quantity: 1, unitAmount: 8000 }], slaCreditPctPerBreach: 10, paymentTerms: "Net 30", signedBy: "Dana Whitaker, VP Clinical Operations, Lumen Clinics Network, PLLC", clauses: ["Service Level: 99.9% monthly availability. For each calendar month below target, Customer receives a service credit of 10% of that month's subscription fee, applied to the next invoice upon written request within 30 days.", ...STD_CLAUSES] },
  { key: "c_orchid_2025", accountKey: "orchid_legal", title: "Order Form OL-2025", status: "active", startDate: "2025-09-10", termMonths: 12, billing: "annual_upfront", lines: [seat(10)], upliftPct: 7, paymentTerms: "Net 30", signedBy: "Theo Marsh, Office Administrator, Orchid Legal LLP", clauses: ["Renews automatically for 12-month terms. Renewal fees increase by 7% over the prior term's fees.", ...STD_CLAUSES] },
  { key: "c_sequoia_2026", accountKey: "sequoia_freight", title: "Order Form SFL-2026", status: "active", startDate: "2026-07-25", termMonths: 12, billing: "quarterly", lines: [seat(25), impl(1000)], paymentTerms: "Net 30", signedBy: "Carmen Ortiz, Accounts Payable Manager, Sequoia Freight Lines, Inc.", clauses: STD_CLAUSES },
  { key: "c_keystone_2026", accountKey: "keystone_apparel", title: "Order Form KAG-2026", status: "active", startDate: "2026-09-01", termMonths: 12, billing: "annual_upfront", lines: [seat(3, 1400)], paymentTerms: "Due on receipt", signedBy: "Nate Russo, Owner, Keystone Apparel Group LLC", clauses: STD_CLAUSES },
  { key: "c_beacon_2026", accountKey: "beacon_schools", title: "Order Form BCS-2026", status: "active", startDate: "2026-08-21", termMonths: 12, billing: "annual_upfront", lines: [seat(8)], paymentTerms: "Net 30", signedBy: "Latoya Grant, Network Finance Director, Beacon Charter Schools Network", clauses: STD_CLAUSES },
  { key: "c_atlas_2026", accountKey: "atlas_pharma", title: "Order Form APU-2026", status: "active", startDate: "2026-08-10", termMonths: 12, billing: "annual_upfront", lines: [seat(15), impl(4000)], paymentTerms: "Net 45", signedBy: "Victor Chen, Head of R&D Informatics, Atlas Pharma US, Inc.", clauses: ["Every invoice must display Customer's federal tax ID (EIN 56-2290714). Invoices without it cannot be processed by Customer's AP system.", ...STD_CLAUSES] },
  { key: "c_kestrel_2026", accountKey: "kestrel_foods", title: "Order Form KFC-2026", status: "active", startDate: "2026-07-30", termMonths: 12, billing: "annual_upfront", lines: [seat(45)], paymentTerms: "Net 45", signedBy: "Paula Jensen, AP Manager, Kestrel Foods Corporation", clauses: STD_CLAUSES },
  { key: "c_orion_2026", accountKey: "orion_dental", title: "Order Form ODL-2026", status: "active", startDate: "2026-05-12", termMonths: 12, billing: "annual_upfront", lines: [seat(2)], paymentTerms: "Net 30", signedBy: "Rafael Ortega, Owner, Orion Dental Laboratories LLC", clauses: STD_CLAUSES },
  { key: "c_keystone_placeholder", accountKey: "keystone_apparel", title: "Superseded quote KAG-Q1", status: "expired", startDate: "2026-03-01", termMonths: 1, billing: "one_time", lines: [seat(2, 1400)], paymentTerms: "Due on receipt", signedBy: "unsigned quote", clauses: ["Quote expired unsigned."] },
  { key: "c_east_bridge_coffee_2026", accountKey: "east_bridge_coffee", title: "Self-serve subscription", status: "active", startDate: "2026-02-01", termMonths: 1, billing: "monthly", lines: [seatM(4)], paymentTerms: "Due on receipt", signedBy: "Molly Brennan (click-through)", clauses: ["Charged monthly to card on file."] },
  { key: "c_acme_corp_2026", accountKey: "acme_corporation", title: "Order Form ACME-2026", status: "active", startDate: "2026-01-15", termMonths: 12, billing: "annual_upfront", lines: [seat(100), support()], paymentTerms: "Net 30", signedBy: "Walter Grimes, AP Director, ACME Corporation", clauses: STD_CLAUSES },
  { key: "c_acme_rob_2026", accountKey: "acme_robotics", title: "Order Form ARI-2026", status: "active", startDate: "2026-04-01", termMonths: 12, billing: "annual_upfront", lines: [seat(6)], paymentTerms: "Net 30", signedBy: "Yuki Sato, CEO, Acme Robotics Inc.", clauses: STD_CLAUSES },
  { key: "c_globex_2026", accountKey: "globex_systems", title: "Order Form GLX-2026 (signed as Globex Corporation)", status: "active", startDate: "2026-03-01", termMonths: 12, billing: "annual_upfront", lines: [seat(22)], paymentTerms: "Net 30", signedBy: "Hank Scorpio, Finance Lead, Globex Corporation (now Globex Systems, Inc.)", clauses: ["Name change notice dated June 3, 2026: Globex Corporation is now Globex Systems, Inc. EIN unchanged.", ...STD_CLAUSES] },
  { key: "c_nw_traders_2026", accountKey: "northwind_traders", title: "Order Form NWT-2026", status: "active", startDate: "2026-05-01", termMonths: 12, billing: "annual_upfront", lines: [seat(4)], paymentTerms: "Net 30", signedBy: "Aaron Fuller, Owner, Northwind Traders Co.", clauses: STD_CLAUSES },
  { key: "c_meridian_cap_2026", accountKey: "meridian_capital", title: "Order Form MCA-2026", status: "active", startDate: "2026-06-01", termMonths: 12, billing: "annual_upfront", lines: [seat(5)], paymentTerms: "Net 30", signedBy: "Beth Carlisle, COO, Meridian Capital Advisors LLC", clauses: STD_CLAUSES },
  ...HEALTHY_SPECS.map(([key, , legal, , , segment, , , , seats], i): Contract => ({
    key: `c_${key}_2026`, accountKey: key, title: `Order Form ${key.slice(0, 3).toUpperCase()}-2026`, status: "active",
    startDate: `2026-0${(i % 8) + 1}-01`, termMonths: 12, billing: "annual_upfront",
    lines: segment === "enterprise" ? [seat(seats), support()] : [seat(seats)],
    paymentTerms: segment === "enterprise" ? "Net 45" : "Net 30", signedBy: `Authorized signatory, ${legal}`, clauses: STD_CLAUSES,
  })),
];

export const OPPORTUNITIES: Opportunity[] = [
  { key: "o_eb_logistics_new", accountKey: "eastbridge_logistics", name: "Eastbridge Logistics — Fleet rollout 80 seats", stage: "Closed Won", amount: 101000, closeDate: "2026-08-14", contractKey: "c_eb_logistics_2026", type: "New Business" },
  { key: "o_eb_holdings_renewal", accountKey: "eastbridge_holdings", name: "Eastbridge Holdings — FY27 renewal", stage: "Closed Won", amount: 24000, closeDate: "2026-08-25", contractKey: "c_eb_holdings_2025", type: "Renewal" },
  { key: "o_eb_holdings_expansion", accountKey: "eastbridge_holdings", name: "Eastbridge Holdings — Warehouse analytics expansion", stage: "Negotiation/Review", amount: 36000, closeDate: "2026-10-15", type: "Expansion", nextStep: "Security review with Olivia Park" },
  { key: "o_pinecrest_new", accountKey: "pinecrest_analytics", name: "Pinecrest Analytics — Platform + Implementation", stage: "Closed Won", amount: 60000, closeDate: "2026-09-01", contractKey: "c_pinecrest_2026", type: "New Business" },
  { key: "o_halcyon_new", accountKey: "halcyon_bio", name: "Halcyon Bio — Lab informatics 30 seats", stage: "Closed Won", amount: 36000, closeDate: "2026-09-10", contractKey: "c_halcyon_2026", type: "New Business" },
  { key: "o_quarry_renewal", accountKey: "quarry_labs", name: "Quarry Labs — 2026 renewal (multi-year discount)", stage: "Closed Won", amount: 28800, closeDate: "2026-09-08", contractKey: "c_quarry_2026", type: "Renewal" },
  { key: "o_meridian_renewal", accountKey: "meridian_health", name: "Meridian Health — FY27 renewal 150 seats", stage: "Closed Won", amount: 180000, closeDate: "2026-09-04", contractKey: "c_meridian_2026", type: "Renewal", nextStep: "Awaiting PO from procurement" },
  { key: "o_falcon_new", accountKey: "falcon_aerospace", name: "Falcon Aerospace — Engineering rollout", stage: "Closed Won", amount: 77000, closeDate: "2026-08-28", contractKey: "c_falcon_2026", type: "New Business" },
  { key: "o_tidewater_expansion", accountKey: "tidewater_energy", name: "Tidewater Energy — +25 seats (Amendment 1)", stage: "Closed Won", amount: 8250, closeDate: "2026-09-08", contractKey: "c_tidewater_2026", type: "Expansion" },
  { key: "o_northwind_ea", accountKey: "northwind_group", name: "Northwind Group — Enterprise Agreement", stage: "Closed Won", amount: 42000, closeDate: "2026-08-01", contractKey: "c_northwind_2026", type: "New Business" },
  { key: "o_vantage_new", accountKey: "vantage_robotics", name: "Vantage Robotics — Platform with usage", stage: "Closed Won", amount: 59400, closeDate: "2026-01-25", contractKey: "c_vantage_2026", type: "New Business" },
  { key: "o_lumen_network", accountKey: "lumen_clinics", name: "Lumen Clinics — Network plan 24 months", stage: "Closed Won", amount: 192000, closeDate: "2026-03-20", contractKey: "c_lumen_2026", type: "New Business" },
  { key: "o_orchid_renewal", accountKey: "orchid_legal", name: "Orchid Legal — 2026 auto-renewal", stage: "Closed Won", amount: 12840, closeDate: "2026-09-10", contractKey: "c_orchid_2025", type: "Renewal" },
  { key: "o_sequoia_new", accountKey: "sequoia_freight", name: "Sequoia Freight — Dispatch platform", stage: "Closed Won", amount: 31000, closeDate: "2026-07-20", contractKey: "c_sequoia_2026", type: "New Business" },
  { key: "o_atlas_new", accountKey: "atlas_pharma", name: "Atlas Pharma — R&D informatics", stage: "Closed Won", amount: 22000, closeDate: "2026-08-05", contractKey: "c_atlas_2026", type: "New Business" },
  { key: "o_atlas_expansion", accountKey: "atlas_pharma", name: "Atlas Pharma — Clinical ops expansion", stage: "Prospecting", amount: 45000, closeDate: "2026-12-01", type: "Expansion" },
  { key: "o_kestrel_new", accountKey: "kestrel_foods", name: "Kestrel Foods — Plant operations", stage: "Closed Won", amount: 54000, closeDate: "2026-07-28", contractKey: "c_kestrel_2026", type: "New Business" },
  { key: "o_acme_corp", accountKey: "acme_corporation", name: "ACME Corporation — 2026 platform", stage: "Closed Won", amount: 125000, closeDate: "2026-01-10", contractKey: "c_acme_corp_2026", type: "New Business" },
  { key: "o_acme_corp_lost", accountKey: "acme_corporation", name: "ACME Corporation — Robotics division pilot", stage: "Closed Lost", amount: 18000, closeDate: "2026-06-30", type: "Expansion" },
  { key: "o_globex", accountKey: "globex_systems", name: "Globex Corporation — 2026 platform", stage: "Closed Won", amount: 26400, closeDate: "2026-02-20", contractKey: "c_globex_2026", type: "New Business" },
  { key: "o_meridian_capital", accountKey: "meridian_capital", name: "Meridian Capital Advisors — starter", stage: "Closed Won", amount: 6000, closeDate: "2026-05-28", contractKey: "c_meridian_cap_2026", type: "New Business" },
  ...HEALTHY_SPECS.map(([key, name, , , , segment, , , , seats], i): Opportunity => ({
    key: `o_${key}`, accountKey: key, name: `${name} — 2026 platform`, stage: "Closed Won",
    amount: seats * 1200 + (segment === "enterprise" ? 5000 : 0), closeDate: `2026-0${(i % 8) + 1}-01`, contractKey: `c_${key}_2026`, type: "New Business",
  })),
  ...HEALTHY_SPECS.slice(0, 6).map(([key, name, , , , , , , , seats]): Opportunity => ({
    key: `o_${key}_expansion`, accountKey: key, name: `${name} — expansion`, stage: "Negotiation/Review", amount: Math.round(seats * 0.5) * 1200, closeDate: "2026-11-15", type: "Expansion",
  })),
];

export const SUBSCRIPTIONS: Subscription[] = [
  { key: "s_tidewater", accountKey: "tidewater_energy", contractKey: "c_tidewater_2026", productKey: "seat_monthly", quantity: 50, unitAmount: 110, interval: "month", status: "active", paymentMethod: "send_invoice" },
  { key: "s_solstice", accountKey: "solstice_media", contractKey: "c_solstice_2026", productKey: "seat_monthly", quantity: 12, unitAmount: 110, interval: "month", status: "past_due", paymentMethod: "card_fails" },
  { key: "s_vantage", accountKey: "vantage_robotics", contractKey: "c_vantage_2026", productKey: "seat_monthly", quantity: 45, unitAmount: 110, interval: "month", status: "active", paymentMethod: "send_invoice" },
  { key: "s_lumen", accountKey: "lumen_clinics", contractKey: "c_lumen_2026", productKey: "platform_flat_monthly", quantity: 1, unitAmount: 8000, interval: "month", status: "active", paymentMethod: "send_invoice" },
  { key: "s_east_bridge_coffee", accountKey: "east_bridge_coffee", contractKey: "c_east_bridge_coffee_2026", productKey: "seat_monthly", quantity: 4, unitAmount: 110, interval: "month", status: "active", paymentMethod: "card_ok" },
  ...HEALTHY_SPECS.filter(([, , , , , segment]) => segment === "smb").map(([key, , , , , , , , , seats]): Subscription => ({
    key: `s_${key}`, accountKey: key, contractKey: `c_${key}_2026`, productKey: "seat_monthly", quantity: seats, unitAmount: 110, interval: "month", status: "active", paymentMethod: "card_ok",
  })),
];

// ---------------------------------------------------------------------------------------------
// Invoices. Stripe holds issued billing documents; QuickBooks is the accounting ledger.
// Normally both exist (a sync mirrors Stripe to QuickBooks); some cases break that on purpose.
// ---------------------------------------------------------------------------------------------
const inv = (i: Invoice): Invoice => i;
const both = (s: Invoice["stripe"], q: Invoice["qbo"]) => ({ stripe: s, qbo: q });

export const INVOICES: Invoice[] = [
  // Eastbridge: Logistics contract billed to Holdings by mistake; Holdings renewal legitimately open.
  inv({ key: "i_2381", number: "INV-2381", accountKey: "eastbridge_holdings", contractKey: "c_eb_logistics_2026", issueDate: "2026-08-20", dueDate: "2026-09-19", lines: [seat(80), support()], memo: "Fleet rollout — Order Form EBL-2026-01", ...both({ state: "open" }, { state: "open" }) }),
  inv({ key: "i_2355", number: "INV-2355", accountKey: "eastbridge_holdings", contractKey: "c_eb_holdings_2025", issueDate: "2026-09-01", dueDate: "2026-10-01", lines: [seat(20)], memo: "Annual renewal Sep 2026 – Aug 2027", ...both({ state: "open" }, { state: "open" }) }),
  inv({ key: "i_2102", number: "INV-2102", accountKey: "eastbridge_holdings", contractKey: "c_eb_holdings_2025", issueDate: "2025-09-01", dueDate: "2025-10-01", lines: [seat(20)], memo: "Annual subscription Sep 2025 – Aug 2026", qbo: { state: "paid" } }),
  // Pinecrest and Halcyon: closed deals with no invoice yet (intentionally absent).
  // Quarry: draft at list price instead of contracted discount.
  inv({ key: "i_2390", number: "INV-2390", accountKey: "quarry_labs", contractKey: "c_quarry_2026", issueDate: "2026-09-14", dueDate: "2026-09-29", lines: [seat(30)], memo: "Renewal Sep 2026 – Sep 2027", stripe: { state: "draft" } }),
  inv({ key: "i_2088", number: "INV-2088", accountKey: "quarry_labs", issueDate: "2025-09-15", dueDate: "2025-09-30", lines: [seat(25, 960)], qbo: { state: "paid" }, stripe: { state: "paid", paidDate: "2025-09-20" } }),
  // Meridian: renewal draft with no PO. Falcon: PO received but not on the draft.
  inv({ key: "i_2392", number: "INV-2392", accountKey: "meridian_health", contractKey: "c_meridian_2026", issueDate: "2026-09-14", dueDate: "2026-11-13", lines: [seat(150)], memo: "Renewal Oct 2026 – Sep 2027", stripe: { state: "draft" } }),
  inv({ key: "i_1975", number: "INV-1975", accountKey: "meridian_health", issueDate: "2025-09-15", dueDate: "2025-11-14", lines: [seat(140)], poNumber: "PO-MHS-55120", qbo: { state: "paid" } }),
  inv({ key: "i_2388", number: "INV-2388", accountKey: "falcon_aerospace", contractKey: "c_falcon_2026", issueDate: "2026-09-02", dueDate: "2026-10-17", lines: [seat(60), support()], memo: "Engineering rollout — year 1", stripe: { state: "draft" } }),
  // Tidewater: monthly seats, amendment pending.
  inv({ key: "i_2341", number: "INV-2341", accountKey: "tidewater_energy", contractKey: "c_tidewater_2026", issueDate: "2026-08-01", dueDate: "2026-08-31", lines: [seatM(50)], memo: "August 2026 seats", ...both({ state: "paid", subscriptionKey: "s_tidewater", paidDate: "2026-08-27" }, { state: "paid" }) }),
  inv({ key: "i_2371", number: "INV-2371", accountKey: "tidewater_energy", contractKey: "c_tidewater_2026", issueDate: "2026-09-01", dueDate: "2026-10-01", lines: [seatM(50)], memo: "September 2026 seats", ...both({ state: "open", subscriptionKey: "s_tidewater" }, { state: "open" }) }),
  // Solstice: card declined.
  inv({ key: "i_2377", number: "INV-2377", accountKey: "solstice_media", contractKey: "c_solstice_2026", issueDate: "2026-09-01", dueDate: "2026-09-01", lines: [seatM(12)], memo: "September 2026 seats", ...both({ state: "payment_failed", subscriptionKey: "s_solstice" }, { state: "open" }) }),
  inv({ key: "i_2340", number: "INV-2340", accountKey: "solstice_media", contractKey: "c_solstice_2026", issueDate: "2026-08-01", dueDate: "2026-08-01", lines: [seatM(12)], memo: "August 2026 seats", ...both({ state: "paid", subscriptionKey: "s_solstice", paidDate: "2026-08-01" }, { state: "paid" }) }),
  // Collections population.
  inv({ key: "i_2204", number: "INV-2204", accountKey: "harbor_pine", contractKey: "c_harbor_2026", issueDate: "2026-07-01", dueDate: "2026-07-31", lines: [seat(14), training(1600)], qbo: { state: "open" } }),
  inv({ key: "i_2150", number: "INV-2150", accountKey: "copperleaf_supply", contractKey: "c_copperleaf_2026", issueDate: "2026-06-14", dueDate: "2026-07-14", lines: [seat(7), { productKey: "training", quantity: 1, unitAmount: 1350 }], qbo: { state: "open" } }),
  inv({ key: "i_2318", number: "INV-2318", accountKey: "brightline_studios", contractKey: "c_brightline_2026", issueDate: "2026-07-22", dueDate: "2026-08-06", lines: [seat(5, 1240)], ...both({ state: "paid", paidDate: "2026-09-12" }, { state: "open" }) }),
  inv({ key: "i_2296", number: "INV-2296", accountKey: "crescent_dental", contractKey: "c_crescent_2026", issueDate: "2026-07-28", dueDate: "2026-08-27", lines: [seat(10), { productKey: "training", quantity: 1, unitAmount: 600 }], qbo: { state: "open" } }),
  inv({ key: "i_2291", number: "INV-2291", accountKey: "ridgeview_usd", contractKey: "c_ridgeview_usd_2026", issueDate: "2026-08-01", dueDate: "2026-09-15", lines: [seat(6, 1250)], qbo: { state: "open" } }),
  inv({ key: "i_2293", number: "INV-2293", accountKey: "ridgeview_capital", contractKey: "c_ridgeview_cap_2026", issueDate: "2026-08-03", dueDate: "2026-09-02", lines: [seat(6, 1250)], qbo: { state: "open" } }),
  inv({ key: "i_2240", number: "INV-2240", accountKey: "northwind_retail", contractKey: "c_northwind_2026", issueDate: "2026-08-05", dueDate: "2026-09-04", lines: [seat(15)], qbo: { state: "open" } }),
  inv({ key: "i_2241", number: "INV-2241", accountKey: "northwind_health", contractKey: "c_northwind_2026", issueDate: "2026-08-05", dueDate: "2026-09-04", lines: [seat(12, 1250)], qbo: { state: "open" } }),
  inv({ key: "i_2242", number: "INV-2242", accountKey: "northwind_group", contractKey: "c_northwind_2026", issueDate: "2026-08-05", dueDate: "2026-09-04", lines: [seat(6), training(1800)], qbo: { state: "open" } }),
  inv({ key: "i_2270", number: "INV-2270", accountKey: "vantage_robotics", contractKey: "c_vantage_2026", issueDate: "2026-08-31", dueDate: "2026-09-30", lines: [seatM(45), { productKey: "api_overage", description: "API overage August 2026 — 22,100,000 calls over plan", quantity: 17100, unitAmount: 0.4 }], memo: "August 2026 seats and usage", ...both({ state: "open" }, { state: "open" }) }),
  inv({ key: "i_2238", number: "INV-2238", accountKey: "vantage_robotics", contractKey: "c_vantage_2026", issueDate: "2026-07-31", dueDate: "2026-08-30", lines: [seatM(45), { productKey: "api_overage", description: "API overage July 2026", quantity: 3100, unitAmount: 0.4 }], ...both({ state: "paid", paidDate: "2026-08-26" }, { state: "paid" }) }),
  inv({ key: "i_2379", number: "INV-2379", accountKey: "lumen_clinics", contractKey: "c_lumen_2026", issueDate: "2026-09-01", dueDate: "2026-10-01", lines: [{ productKey: "platform_flat_monthly", quantity: 1, unitAmount: 8000 }], memo: "September 2026 network plan", ...both({ state: "open", subscriptionKey: "s_lumen" }, { state: "open" }) }),
  inv({ key: "i_2339", number: "INV-2339", accountKey: "lumen_clinics", contractKey: "c_lumen_2026", issueDate: "2026-08-01", dueDate: "2026-08-31", lines: [{ productKey: "platform_flat_monthly", quantity: 1, unitAmount: 8000 }], memo: "August 2026 network plan", ...both({ state: "paid", subscriptionKey: "s_lumen", paidDate: "2026-08-29" }, { state: "paid" }) }),
  inv({ key: "i_2384", number: "INV-2384", accountKey: "orchid_legal", contractKey: "c_orchid_2025", issueDate: "2026-09-10", dueDate: "2026-10-10", lines: [seat(10, 1284)], memo: "Renewal Sep 2026 – Sep 2027 (7% uplift per Order Form OL-2025)", ...both({ state: "open" }, { state: "open" }) }),
  inv({ key: "i_2011", number: "INV-2011", accountKey: "orchid_legal", contractKey: "c_orchid_2025", issueDate: "2025-09-10", dueDate: "2025-10-10", lines: [seat(10)], ...both({ state: "paid", paidDate: "2025-10-02" }, { state: "paid" }) }),
  inv({ key: "i_2231", number: "INV-2231", accountKey: "sequoia_freight", contractKey: "c_sequoia_2026", issueDate: "2026-07-25", dueDate: "2026-08-24", lines: [{ productKey: "seat_annual", description: "Platform seats — Q3 2026 (25 seats)", quantity: 25, unitAmount: 1200 }, impl(1000)], qbo: { state: "partial", amountPaid: 11000 } }),
  inv({ key: "i_2302", number: "INV-2302", accountKey: "sequoia_freight", contractKey: "c_sequoia_2026", issueDate: "2026-08-25", dueDate: "2026-09-24", lines: [{ productKey: "training", description: "Dispatcher training (4 sessions)", quantity: 4, unitAmount: 2100 }], qbo: { state: "open" } }),
  inv({ key: "i_2357", number: "INV-2357", accountKey: "sequoia_freight", contractKey: "c_sequoia_2026", issueDate: "2026-09-05", dueDate: "2026-10-05", lines: [{ productKey: "api_overage", description: "API overage August 2026", quantity: 14000, unitAmount: 0.4 }], qbo: { state: "open" } }),
  inv({ key: "i_2366", number: "INV-2366", accountKey: "keystone_apparel", contractKey: "c_keystone_2026", issueDate: "2026-09-01", dueDate: "2026-09-01", lines: [seat(3, 1400)], ...both({ state: "paid", paidDate: "2026-09-09" }, { state: "open" }) }),
  inv({ key: "i_2299", number: "INV-2299", accountKey: "beacon_schools", contractKey: "c_beacon_2026", issueDate: "2026-08-21", dueDate: "2026-09-20", lines: [seat(8)], ...both({ state: "open" }, { state: "open" }) }),
  inv({ key: "i_2299_dup", number: "INV-2299-1", accountKey: "beacon_schools", contractKey: "c_beacon_2026", issueDate: "2026-08-21", dueDate: "2026-09-20", lines: [seat(8)], memo: "Created by sync retry", qbo: { state: "open", duplicateOf: "i_2299" } }),
  inv({ key: "i_2263", number: "INV-2263", accountKey: "atlas_pharma", contractKey: "c_atlas_2026", issueDate: "2026-08-10", dueDate: "2026-09-24", lines: [seat(15), impl(4000)], ...both({ state: "open" }, { state: "open" }) }),
  inv({ key: "i_2335", number: "INV-2335", accountKey: "kestrel_foods", contractKey: "c_kestrel_2026", issueDate: "2026-07-30", dueDate: "2026-08-29", lines: [seat(45)], qbo: { state: "open" } }),
  inv({ key: "i_1990", number: "INV-1990", accountKey: "orion_dental", contractKey: "c_orion_2026", issueDate: "2026-05-12", dueDate: "2026-06-11", lines: [seat(2)], qbo: { state: "open" } }),
  // Lookalikes: all settled or current.
  inv({ key: "i_2372", number: "INV-2372", accountKey: "east_bridge_coffee", issueDate: "2026-09-01", dueDate: "2026-09-01", lines: [seatM(4)], ...both({ state: "paid", subscriptionKey: "s_east_bridge_coffee", paidDate: "2026-09-01" }, { state: "paid" }) }),
  inv({ key: "i_2055", number: "INV-2055", accountKey: "acme_corporation", issueDate: "2026-01-15", dueDate: "2026-02-14", lines: [seat(100), support()], ...both({ state: "paid", paidDate: "2026-02-10" }, { state: "paid" }) }),
  inv({ key: "i_2160", number: "INV-2160", accountKey: "acme_robotics", issueDate: "2026-04-01", dueDate: "2026-05-01", lines: [seat(6)], ...both({ state: "paid", paidDate: "2026-04-22" }, { state: "paid" }) }),
  inv({ key: "i_2360", number: "INV-2360", accountKey: "acme_robotics", issueDate: "2026-09-08", dueDate: "2026-10-08", lines: [{ productKey: "training", quantity: 1, unitAmount: 1800 }], ...both({ state: "open" }, { state: "open" }) }),
  inv({ key: "i_2092", number: "INV-2092", accountKey: "globex_systems", issueDate: "2026-03-01", dueDate: "2026-03-31", lines: [seat(22)], ...both({ state: "paid", paidDate: "2026-03-28" }, { state: "paid" }) }),
  inv({ key: "i_2201", number: "INV-2201", accountKey: "northwind_traders", issueDate: "2026-05-01", dueDate: "2026-05-31", lines: [seat(4)], qbo: { state: "paid" }, stripe: { state: "paid", paidDate: "2026-05-18" } }),
  inv({ key: "i_2215", number: "INV-2215", accountKey: "meridian_capital", issueDate: "2026-06-01", dueDate: "2026-07-01", lines: [seat(5)], ...both({ state: "paid", paidDate: "2026-06-25" }, { state: "paid" }) }),
  // Healthy background: annual invoice paid, plus a current not-yet-due invoice for every third account.
  ...HEALTHY_SPECS.flatMap(([key, , , , , segment, , , , seats], i): Invoice[] => {
    const month = (i % 8) + 1;
    const lines = segment === "enterprise" ? [seat(seats), support()] : [seat(seats)];
    const out: Invoice[] = [inv({ key: `i_${1800 + i}`, number: `INV-${1800 + i}`, accountKey: key, contractKey: `c_${key}_2026`, issueDate: `2026-0${month}-01`, dueDate: `2026-0${month}-${segment === "enterprise" ? "28" : "30"}`.replace("-02-30", "-02-28"), lines, qbo: { state: "paid" }, stripe: segment === "enterprise" ? undefined : { state: "paid", paidDate: `2026-0${month}-20` } })];
    if (i % 3 === 0) out.push(inv({ key: `i_${2400 + i}`, number: `INV-${2400 + i}`, accountKey: key, issueDate: "2026-09-10", dueDate: "2026-10-10", lines: [{ productKey: "training", quantity: 1, unitAmount: 1800 }], qbo: { state: "open" }, stripe: segment === "enterprise" ? undefined : { state: "open" } }));
    return out;
  }),
];

// ---------------------------------------------------------------------------------------------
// Payments recorded in QuickBooks (bank deposits) and Stripe (card/hosted invoice).
// Paid invoices above imply a matching applied payment; seeders create those automatically.
// The entries below are the deliberate cases: unapplied, partial, grouped, lookalike.
// ---------------------------------------------------------------------------------------------
export const PAYMENTS: Payment[] = [
  { key: "p_ebh_0910", system: "qbo", payerName: "EASTBRIDGE HOLDINGS INC", accountKey: "eastbridge_holdings", amount: 24000, date: "2026-09-10", method: "ACH", reference: "EBH-ACH-240910 / INV2355", applications: [] },
  { key: "p_cdg_0902", system: "qbo", payerName: "CDG PARTNERS LLC", accountKey: "cdg_partners", amount: 12600, date: "2026-09-02", method: "ACH", reference: "ACH TRACE 0829-CDG-4471", applications: [] },
  { key: "p_rvsd_0911", system: "qbo", payerName: "RIDGEVIEW UNIFIED SCH DIST", accountKey: "ridgeview_usd", amount: 7500, date: "2026-09-11", method: "Check", reference: "COUNTY WARRANT 55871 INV 2291", applications: [] },
  { key: "p_nwg_0911", system: "qbo", payerName: "NORTHWIND GROUP HOLDINGS", accountKey: "northwind_group", amount: 41550, date: "2026-09-11", method: "Wire", reference: "NWG-WIRE-7730 REMIT ADV SENT", applications: [] },
  { key: "p_sequoia_0820", system: "qbo", payerName: "SEQUOIA FREIGHT LINES", accountKey: "sequoia_freight", amount: 11000, date: "2026-08-20", method: "ACH", reference: "SFL AP RUN 0820", applications: [{ invoiceKey: "i_2231", amount: 11000 }] },
  // No customer could be identified; the bookkeeper parked it under a holding customer in QuickBooks.
  { key: "p_unknown_0913", system: "qbo", payerName: "ACH DEPOSIT — ORIGINATOR ID 1847739920", amount: 1850, date: "2026-09-13", method: "ACH", reference: "NO ADDENDA", applications: [] },
];

export const CREDIT_MEMOS: CreditMemo[] = [
  { key: "cm_vantage_june", accountKey: "vantage_robotics", date: "2026-07-05", amount: 400, reason: "Goodwill credit — June onboarding delay", system: "qbo" },
];
