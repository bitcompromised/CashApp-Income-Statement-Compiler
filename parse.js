const fs = require("fs");
const path = require("path");
const pdfParse = require("pdf-parse");


/*
 * ============================================================
 * ROBUST PDF LOADING
 * ============================================================
 *
 * pdf-parse@1.1.1 bundles an old build of pdf.js whose xref
 * recovery path ("Indexing all PDF objects") is timing
 * sensitive. On some statements it intermittently throws
 * "Invalid PDF structure" even though the document is
 * perfectly readable - the outcome flips based on unrelated
 * event-loop timing (e.g. a console.log right before the call).
 *
 * Retrying the parse in the same process reliably succeeds, so
 * we attempt each file a few times before giving up.
 * ============================================================
 */
async function loadPdf(
  buffer,
  attempts = 4
) {
  let lastError = null;

  for (
    let i = 0;
    i < attempts;
    i++
  ) {
    try {
      return await pdfParse(
        buffer
      );
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError;
}

/*
 * ============================================================
 * CASH APP PDF PARSER
 * ============================================================
 *
 * Changes in this version:
 *
 * 1. More robust transaction amount parsing.
 *    Cash App outgoing transactions often have NO "-" sign:
 *
 *      To Big L Cash App payment $0.00 $50.00
 *
 *    Direction is therefore determined from "To"/"From".
 *
 * 2. Incoming transactions with "+$5,025.73" are parsed correctly.
 *
 * 3. Person-to-person activity is detected from actual
 *    "Cash App payment" transactions with a real person after
 *    To/From.
 *
 * 4. Bank/card/savings destinations are excluded from people.
 *
 * 5. Reconciliation now displays:
 *
 *      Money In
 *      Net
 *
 *    instead of Money Out.
 *
 * 6. Net Out % now measures net loss/profit relative to Money In.
 *
 *      profit = positive %
 *      loss   = negative %
 *
 * ============================================================
 */


/* ============================================================
 * CONFIGURATION
 * ============================================================ */

const INPUT_DIR = __dirname;

const JSON_OUTPUT =
  path.join(
    INPUT_DIR,
    "cashapp-summary.json"
  );

const CSV_OUTPUT =
  path.join(
    INPUT_DIR,
    "cashapp-summary.csv"
  );

const TRANSACTION_CSV_OUTPUT =
  path.join(
    INPUT_DIR,
    "cashapp-transactions.csv"
  );


/* ============================================================
 * MONTHS
 * ============================================================ */

const MONTHS = {
  Jan: 0,
  Feb: 1,
  Mar: 2,
  Apr: 3,
  May: 4,
  Jun: 5,
  Jul: 6,
  Aug: 7,
  Sep: 8,
  Oct: 9,
  Nov: 10,
  Dec: 11,
};


/* ============================================================
 * KNOWN TRANSACTION MARKERS
 * ============================================================ */

const TRANSACTION_MARKERS = [
  "Cash App Card (pending)",
  "Bitcoin sale (canceled)",
  "Bitcoin sale",
  "Bitcoin buy",
  "Cash App Card",
  "Cash App payment",
  "Cash App Pay",
  "Standard transfer",
  "Instant transfer (canceled)",
  "Instant transfer",
  "Transfer",
  "Paper money deposit",
  "Direct deposit",
  "Voided transaction adjustment",
  "Overdraft coverage repayment",
  "Monthly interest",
  "Savings interest",
  "Stock sale",
  "Stock buy",
];


/*
 * Longest markers first.
 */
const TRANSACTION_MARKER_REGEX =
  new RegExp(
    `(${TRANSACTION_MARKERS
      .slice()
      .sort(
        (a, b) =>
          b.length - a.length
      )
      .map(escapeRegex)
      .join("|")})`,
    "i"
  );


function escapeRegex(value) {
  return String(value).replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&"
  );
}


/* ============================================================
 * MONEY
 * ============================================================ */

const MONEY_TOKEN =
  `[+-]?\\s*\\$[\\d,]+\\.\\d{2}`;


const MONEY_REGEX =
  new RegExp(
    MONEY_TOKEN,
    "g"
  );


function money(value) {
  if (
    value === null ||
    value === undefined
  ) {
    return 0;
  }

  return (
    parseFloat(
      String(value)
        .replace(/\$/g, "")
        .replace(/,/g, "")
        .replace(/\s/g, "")
        .replace(/^\+/, "")
    ) || 0
  );
}


function moneySigned(value) {
  const str =
    String(value || "");

  const negative =
    str.includes("-");

  const n =
    money(str);

  return negative
    ? -n
    : n;
}


function round(value) {
  return Math.round(
    (Number(value) +
      Number.EPSILON) *
      100
  ) / 100;
}


function moneyDisplay(value) {
  const n =
    Number(value) || 0;

  const sign =
    n < 0 ? "-" : "";

  return (
    sign +
    "$" +
    Math.abs(n).toLocaleString(
      "en-US",
      {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }
    )
  );
}


/* ============================================================
 * CLEANING
 * ============================================================ */

function clean(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}


/* ============================================================
 * YEAR
 * ============================================================ */

function getYear(text) {
  const heading =
    text.match(
      /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(20\d{2})\b/i
    );

  if (heading) {
    return Number(
      heading[1]
    );
  }

  const years =
    text.match(
      /\b20\d{2}\b/g
    );

  if (
    years &&
    years.length
  ) {
    return Number(
      years[0]
    );
  }

  return new Date().getFullYear();
}


/* ============================================================
 * DATE HELPERS
 * ============================================================ */

function makeDate(
  year,
  monthName,
  day
) {
  const month =
    MONTHS[
      monthName.substring(0, 3)
    ];

  return new Date(
    year,
    month,
    Number(day)
  );
}


function dateString(
  year,
  monthName,
  day
) {
  const d =
    makeDate(
      year,
      monthName,
      day
    );

  return [
    d.getFullYear(),
    String(
      d.getMonth() + 1
    ).padStart(2, "0"),
    String(
      d.getDate()
    ).padStart(2, "0"),
  ].join("-");
}


function monthString(date) {
  return [
    date.getFullYear(),
    String(
      date.getMonth() + 1
    ).padStart(2, "0"),
  ].join("-");
}


/* ============================================================
 * TRANSACTION CLASSIFICATION
 * ============================================================ */

function classifyTransactionMarker(
  marker
) {
  const lower =
    clean(marker).toLowerCase();

  if (
    lower === "cash app card" ||
    lower ===
      "cash app card (pending)"
  ) {
    return "card";
  }

  if (
    lower === "bitcoin buy" ||
    lower === "bitcoin sale" ||
    lower ===
      "bitcoin sale (canceled)"
  ) {
    return "bitcoin";
  }

  if (
    lower === "cash app payment"
  ) {
    return "person";
  }

  if (
    lower === "cash app pay"
  ) {
    return "cash_app_pay";
  }

  if (
    lower === "standard transfer" ||
    lower === "instant transfer" ||
    lower === "transfer"
  ) {
    return "transfer";
  }

  if (
    lower === "paper money deposit" ||
    lower === "direct deposit"
  ) {
    return "deposit";
  }

  if (
    lower === "stock sale"
  ) {
    return "stock_sale";
  }

  if (
    lower === "stock buy"
  ) {
    return "stock_buy";
  }

  if (
    lower === "savings interest" ||
    lower === "monthly interest"
  ) {
    return "interest";
  }

  if (
    lower === "voided transaction adjustment"
  ) {
    return "adjustment";
  }

  if (
    lower === "overdraft coverage repayment"
  ) {
    return "overdraft";
  }

  return "other";
}


/* ============================================================
 * PERSON FILTERING
 * ============================================================ */

function isNonPerson(value) {
  const s =
    clean(value);

  if (!s) {
    return true;
  }

  const lower =
    s.toLowerCase();

  const blocked =
    [
      "cash app",
      "savings",
      "cash balance",
      "cash balance transfer",
      "instant transfer",
      "standard transfer",
      "transfer",
      "deposit",
      "withdrawal",
      "refund",
      "fee",
      "fees",
      "interest",
      "cash out",
      "paper money",
      "bitcoin",
      "stock",
      "stocks",
      "investing",
      "visa debit",
      "mastercard debit",
      "debit card",
      "credit card",
      "stride bank",
      "sutton bank",
      "bancorp",
      "the bancorp bank",
      "bank",
      "pathward",
      "mvb bank",
      "citibank",
      "chime",
    ];

  if (
    blocked.some(
      x =>
        lower === x ||
        lower.startsWith(
          x + " "
        )
    )
  ) {
    return true;
  }

  /*
   * Card/account numbers.
   */
  if (
    /\b(?:visa|mastercard|debit|card)\b/i.test(
      s
    ) &&
    /\d{4}/.test(s)
  ) {
    return true;
  }

  /*
   * Bank accounts.
   */
  if (
    /\bbank\b/i.test(s) &&
    /\d{4}/.test(s)
  ) {
    return true;
  }

  /*
   * Explicit bank/account wording.
   */
  if (
    /\b(?:bank|account|routing)\b/i.test(s)
  ) {
    return true;
  }

  /*
   * $cashtags can be valid people/business identifiers.
   */
  if (
    /^\$[A-Za-z0-9_]+$/.test(s)
  ) {
    return false;
  }

  return false;
}


/* ============================================================
 * PERSON NORMALIZATION
 * ============================================================ */

function normalizePerson(
  value,
  direction
) {
  let s =
    clean(value);

  /*
   * Remove direction.
   */
  s =
    s.replace(
      /^(?:To|From)\s+/i,
      ""
    );

  /*
   * Remove Cash App suffix.
   */
  s =
    s.replace(
      /\s*Cash\s*App\s*$/i,
      ""
    );

  /*
   * Remove payment descriptors.
   */
  s =
    s.replace(
      /\s*(?:Payment|Transfer|Instant|Standard|Refund|Deposit|Withdrawal|Cash Out)\s*$/i,
      ""
    );

  return clean(s);
}


/* ============================================================
 * EXTRACT TRANSACTION DIRECTION
 * ============================================================ */

function getTransactionDirection(
  description,
  amountToken,
  category
) {
  const s =
    clean(description);

  /*
   * Cash App's statement format uses:
   *
   * From Person ... + $25.00
   * To Person ...    $25.00
   *
   * Therefore explicit From/To always wins.
   */
  if (
    /^From\b/i.test(s)
  ) {
    return "received";
  }

  if (
    /^To\b/i.test(s)
  ) {
    return "sent";
  }

  /*
   * Some PDF extraction may join the date and From/To:
   *
   * May27From John Smith ...
   *
   * The date has already been removed before this function.
   */
  if (
    /\bFrom\b/i.test(s)
  ) {
    return "received";
  }

  if (
    /\bTo\b/i.test(s)
  ) {
    return "sent";
  }

  /*
   * Explicit sign.
   */
  const compact =
    String(
      amountToken || ""
    ).replace(
      /\s/g,
      ""
    );

  if (
    compact.startsWith("+")
  ) {
    return "received";
  }

  if (
    compact.startsWith("-")
  ) {
    return "sent";
  }

  /*
   * Card/Bitcoin purchases are outgoing even when Cash App
   * omits the minus sign.
   */
  if (
    category === "card" ||
    category === "bitcoin" ||
    category === "stock_buy"
  ) {
    return "sent";
  }

  /*
   * Stock sale / deposits are incoming.
   */
  if (
    category === "stock_sale" ||
    category === "deposit" ||
    category === "interest"
  ) {
    return "received";
  }

  return null;
}


/* ============================================================
 * EXTRACT PERSON FROM PERSON-TO-PERSON TRANSACTION
 * ============================================================ */

function extractPerson(
  description,
  marker,
  category
) {
  if (
    category !== "person"
  ) {
    return null;
  }

  const match =
    clean(description).match(
      /^(To|From)\s+(.+)$/i
    );

  if (!match) {
    return null;
  }

  let person =
    match[2];

  /*
   * Strip bank intermediary text.
   *
   * Example:
   *
   * To Robert Frost from Pathward x1205
   *
   * becomes:
   *
   * Robert Frost
   */
  person =
    person.replace(
      /\s+from\s+(?:the\s+)?(?:bancorp|pathward|mvb|citibank|chime|sutton|stride)\b.*$/i,
      ""
    );

  person =
    person.replace(
      /\s+from\s+(?:visa|mastercard|debit|bank|account)\b.*$/i,
      ""
    );

  person =
    person.replace(
      /\s+(?:Cash\s*App\s*)?$/i,
      ""
    );

  person =
    normalizePerson(
      person,
      match[1]
    );

  if (
    !person ||
    isNonPerson(person)
  ) {
    return null;
  }

  return person;
}

function extractPersonFromDescription(
  description
) {
  let s =
    clean(description);

  /*
   * Person-to-person transactions MUST have explicit
   * To/From information.
   */
  const match =
    s.match(
      /^(To|From)\s+(.+)$/i
    );

  if (!match) {
    return null;
  }

  const direction =
    match[1];

  s =
    match[2];


  /*
   * Remove intermediary/bank information that can appear
   * after the actual person's name.
   *
   * Examples:
   *
   * To John Smith from Pathward x1234
   * To John Smith from The Bancorp Bank x1234
   */
  s =
    s.replace(
      /\s+from\s+(?:the\s+)?(?:bancorp|pathward|mvb|citibank|chime|sutton|stride)\b.*$/i,
      ""
    );


  /*
   * Remove card/bank/account information.
   */
  s =
    s.replace(
      /\s+(?:from|via)\s+(?:visa|mastercard|debit|credit|bank|account)\b.*$/i,
      ""
    );


  /*
   * Remove Cash App suffix if PDF extraction included it.
   */
  s =
    s.replace(
      /\s*Cash\s*App\s*$/i,
      ""
    );


  /*
   * Remove payment/transfer descriptors.
   */
  s =
    s.replace(
      /\s+(?:payment|transfer|instant|standard)$/i,
      ""
    );


  s =
    normalizePerson(
      s,
      direction
    );


  /*
   * Never allow financial institutions, accounts, cards,
   * or transaction descriptors to become people.
   */
  if (
    !s ||
    isNonPerson(s)
  ) {
    return null;
  }


  return s;
}


/* ============================================================
 * PARSE ONE FLATTENED CASH APP ROW
 * ============================================================ */

function parseCashAppRow(
  line,
  year,
  file
) {
  const originalLine = line;

  line = clean(line);

  /*
   * ----------------------------------------------------------
   * DATE
   * ----------------------------------------------------------
   *
   * Supports:
   *
   * Jan 5
   * Jan5
   */
  const dateMatch =
    line.match(
      /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s*(\d{1,2})(?!\d)/i
    );

  if (!dateMatch) {
    return null;
  }

  const monthName = dateMatch[1];
  const day = dateMatch[2];

  let rest =
    line
      .slice(dateMatch[0].length)
      .trim();


  /*
   * ----------------------------------------------------------
   * FIND TRANSACTION MARKER
   * ----------------------------------------------------------
   */
  const markerMatch =
    rest.match(
      TRANSACTION_MARKER_REGEX
    );

  if (!markerMatch) {
    return null;
  }

  const marker =
    clean(
      markerMatch[1]
    );

  const markerIndex =
    markerMatch.index;


  /*
   * Everything before the marker is the transaction
   * description / To / From party.
   */
  let description =
    rest
      .slice(
        0,
        markerIndex
      )
      .trim();


  /*
   * ----------------------------------------------------------
   * FIND ALL MONEY VALUES
   * ----------------------------------------------------------
   *
   * IMPORTANT:
   *
   * Cash App PDFs are not always extracted in a consistent
   * column order.
   *
   * The transaction amount is the LAST money value on the row.
   *
   * We deliberately do not calculate the amount by subtracting
   * the fee. The PDF already gives us the transaction amount.
   */
  const amounts =
    rest.match(
      new RegExp(
        MONEY_TOKEN,
        "g"
      )
    );

  if (
    !amounts ||
    amounts.length === 0
  ) {
    return null;
  }


  /*
   * Last monetary value = transaction amount.
   */
  const amountToken =
    amounts[
      amounts.length - 1
    ];


  /*
   * Only use the preceding value as a fee when there are
   * actually two values.
   *
   * Do NOT subtract the fee from the transaction amount.
   */
  let fee = 0;

  if (
    amounts.length >= 2
  ) {
    fee =
      Math.abs(
        moneySigned(
          amounts[
            amounts.length - 2
          ]
        )
      );
  }


  /*
   * ----------------------------------------------------------
   * CATEGORY
   * ----------------------------------------------------------
   */
  const category =
    classifyTransactionMarker(
      marker
    );


  /*
   * ----------------------------------------------------------
   * DIRECTION
   * ----------------------------------------------------------
   *
   * Cash App's To / From information is authoritative.
   *
   * This fixes rows such as:
   *
   * To John Smith Cash App payment $0.00 $50.00
   *
   * where the PDF does NOT put a minus sign on $50.00.
   */
  let type = null;

  /*
   * The sign on the transaction amount is authoritative.
   *
   * Every incoming row in a Cash App statement is printed with a
   * leading "+"; outgoing rows have no sign. This reconciles
   * exactly against the statement's Money In / Money Out totals,
   * so it takes priority over everything else (including a card
   * refund such as "...Cash App Card $0.00 + $55.00").
   */
  const compact =
    amountToken.replace(
      /\s/g,
      ""
    );

  if (
    compact.startsWith("+")
  ) {
    type = "received";

  } else if (
    compact.startsWith("-")
  ) {
    type = "sent";
  }


  /*
   * No explicit sign: fall back to the To / From party.
   */
  if (!type) {

    const directionMatch =
      description.match(
        /^(To|From)\b/i
      );

    if (
      directionMatch
    ) {
      type =
        directionMatch[1]
          .toLowerCase() ===
        "from"
          ? "received"
          : "sent";
    }
  }


  /*
   * Still nothing: use the category. Known incoming categories
   * are received; everything else (card purchases, bitcoin buys,
   * overdraft repayments, etc.) is outgoing.
   */
  if (!type) {

    if (
      category === "stock_sale" ||
      category === "deposit" ||
      category === "interest"
    ) {
      type = "received";

    } else {
      type = "sent";
    }
  }


  /*
   * ----------------------------------------------------------
   * AMOUNT
   * ----------------------------------------------------------
   *
   * ALWAYS use the absolute transaction amount and apply the
   * direction ourselves.
   *
   * This handles both:
   *
   *   +$25.01
   *   $25.01
   *   -$25.01
   *
   * without losing a cent.
   */
  const absoluteAmount =
    Math.abs(
      moneySigned(
        amountToken
      )
    );

  const amount =
    type === "received"
      ? absoluteAmount
      : -absoluteAmount;


  /*
   * ----------------------------------------------------------
   * PERSON
   * ----------------------------------------------------------
   *
   * Only Cash App payment rows qualify.
   */
  let person = null;

  if (
    category === "person"
  ) {

    person =
      extractPersonFromDescription(
        description
      );
  }


  /*
   * ----------------------------------------------------------
   * CLEAN DESCRIPTION
   * ----------------------------------------------------------
   */
  description =
    description.replace(
      new RegExp(
        MONEY_TOKEN,
        "g"
      ),
      ""
    );

  description =
    clean(description);


  /*
   * ----------------------------------------------------------
   * DATE
   * ----------------------------------------------------------
   */
  const date =
    makeDate(
      year,
      monthName,
      day
    );


  return {
    sourceFile:
      file,

    date:
      dateString(
        year,
        monthName,
        day
      ),

    month:
      monthString(date),

    type,

    category,

    person,

    description,

    details:
      marker,

    fee:
      round(fee),

    amount:
      round(amount),

    sourceLine:
      originalLine,
  };
}


/* ============================================================
 * REGULAR ACCOUNT STATEMENT
 * ============================================================ */

function parseRegularStatement(
  text,
  file
) {
  const transactions =
    [];

  const year =
    getYear(text);

  const lines =
    text
      .replace(/\r/g, "")
      .split("\n")
      .map(clean)
      .filter(Boolean);

  let inTransactions =
    false;

  let pending =
    null;


  function finalizePending() {
    if (!pending) {
      return;
    }

    const tx =
      parseCashAppRow(
        pending,
        year,
        file
      );

    if (tx) {
      transactions.push(tx);
    }

    pending =
      null;
  }


  for (const line of lines) {

    /*
     * Find transaction section.
     */
    if (
      /^Transactions$/i.test(
        line
      )
    ) {
      inTransactions =
        true;

      continue;
    }

    if (!inTransactions) {
      continue;
    }


    /*
     * Stop at footer.
     */
    if (
      /^All transactions shown/i.test(
        line
      ) ||
      /^In case of errors/i.test(
        line
      ) ||
      /^Contact us/i.test(
        line
      )
    ) {
      finalizePending();

      break;
    }


    /*
     * Ignore headers.
     */
    if (
      /^Date\s+Description/i.test(
        line
      )
    ) {
      continue;
    }


    /*
     * New transaction.
     *
     * Supports:
     *
     * Jan 5
     * Jan5
     * Jan 5To
     */
    const isDateLine =
      /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s*\d{1,2}(?!\d)/i.test(
        line
      );


    if (isDateLine) {

      finalizePending();

      pending =
        line;

      /*
       * Parse immediately when the complete row is already
       * present.
       */
      if (
  TRANSACTION_MARKER_REGEX.test(
    pending
  ) &&
  (
    pending.match(
      new RegExp(
        MONEY_TOKEN,
        "g"
      )
    ) || []
  ).length >= 2
) {
  finalizePending();
}


      continue;
    }


    /*
     * Continuation line.
     */
    if (pending) {

      pending +=
        " " + line;

      /*
       * Once marker + money exist, the row is complete.
       */
      if (
        TRANSACTION_MARKER_REGEX.test(
          pending
        ) &&
        new RegExp(
          MONEY_TOKEN
        ).test(
          pending
        )
      ) {
        finalizePending();
      }
    }
  }


  finalizePending();

  return transactions;
}


/* ============================================================
 * SAVINGS STATEMENT
 * ============================================================ */

function parseSavingsTransactions(
  text,
  file
) {
  const transactions = [];

  const year =
    getYear(text);

  const lines =
    text
      .replace(/\r/g, "")
      .split("\n")
      .map(clean)
      .filter(Boolean);


  for (const line of lines) {

    const tx =
      parseSavingsRow(
        line,
        year,
        file
      );

    if (tx) {
      transactions.push(tx);
    }
  }

  return transactions;
}


function parseSavingsRow(
  line,
  year,
  file
) {
  const originalLine =
    line;

  line =
    clean(line);


  /*
   * Savings PDFs can extract the date as either:
   *
   * May 27
   * May27
   */
  const dateMatch =
    line.match(
      /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s*(\d{1,2})/i
    );

  if (!dateMatch) {
    return null;
  }


  const monthName =
    dateMatch[1];

  const day =
    dateMatch[2];


  let rest =
    line
      .slice(
        dateMatch[0].length
      )
      .trim();


  /*
   * Explicit direction.
   */
  const directionMatch =
    rest.match(
      /^(From|To)\b/i
    );

  if (!directionMatch) {
    return null;
  }


  const type =
    directionMatch[1]
      .toLowerCase() ===
    "from"
      ? "received"
      : "sent";


  /*
   * Find all monetary values.
   *
   * Example:
   *
   * Cash App Transfer $0.00 +$25.01
   *
   * Last value is ALWAYS the transaction amount.
   */
  const amounts =
    rest.match(
      new RegExp(
        MONEY_TOKEN,
        "g"
      )
    );

  if (
    !amounts ||
    amounts.length === 0
  ) {
    return null;
  }


  /*
   * Last amount is the actual transaction amount.
   *
   * Do not subtract the preceding value.
   */
  const amountToken =
    amounts[
      amounts.length - 1
    ];


  /*
   * Fee is only the value immediately preceding the amount.
   * It is metadata and must NEVER be subtracted from amount.
   */
  let fee = 0;

  if (
    amounts.length >= 2
  ) {
    fee =
      Math.abs(
        moneySigned(
          amounts[
            amounts.length - 2
          ]
        )
      );
  }


  const absoluteAmount =
    Math.abs(
      moneySigned(
        amountToken
      )
    );


  const amount =
    type === "received"
      ? absoluteAmount
      : -absoluteAmount;


  /*
   * Description.
   */
  let description =
    rest
      .slice(
        directionMatch[0].length
      )
      .trim();


  /*
   * Remove monetary values.
   */
  description =
    description.replace(
      new RegExp(
        MONEY_TOKEN,
        "g"
      ),
      ""
    );


  /*
   * Remove common transfer descriptors.
   */
  description =
    description.replace(
      /\bCash\s*App\b/gi,
      ""
    );

  description =
    description.replace(
      /\b(?:Transfer|Payment|Deposit|Withdrawal|Refund)\b/gi,
      ""
    );

  description =
    clean(description);


  const date =
    makeDate(
      year,
      monthName,
      day
    );


  return {
    sourceFile:
      file,

    date:
      dateString(
        year,
        monthName,
        day
      ),

    month:
      monthString(date),

    type,

    category:
      "transfer",

    person:
      null,

    description,

    details:
      "Transfer",

    fee:
      round(fee),

    amount:
      round(amount),

    sourceLine:
      originalLine,
  };
}


/* ============================================================
 * STATEMENT TOTALS
 * ============================================================ */

function getStatementTotals(
  text
) {
  const moneyIn =
    text.match(
      /Money\s*In[\s:]*[+]?\s*\$?\s*([\d,]+\.\d{2})/i
    );

  const moneyOut =
    text.match(
      /Money\s*Out[\s:]*[-+]?\s*\$?\s*([\d,]+\.\d{2})/i
    );

  return {
    moneyIn:
      moneyIn
        ? money(moneyIn[1])
        : null,

    moneyOut:
      moneyOut
        ? money(moneyOut[1])
        : null,
  };
}



/* ============================================================
 * AGGREGATION
 * ============================================================ */

function newPerson() {
  return {
    sent: 0,
    received: 0,
    net: 0,
    transactions: 0,
  };
}


function addToPerson(
  map,
  person,
  amount
) {
  if (!person) {
    return;
  }

  if (!map[person]) {
    map[person] =
      newPerson();
  }

  const p =
    map[person];

  p.transactions++;

  if (amount < 0) {

    p.sent =
      round(
        p.sent +
          Math.abs(amount)
      );

    p.net =
      round(
        p.net +
          amount
      );

  } else {

    p.received =
      round(
        p.received +
          amount
      );

    p.net =
      round(
        p.net +
          amount
      );
  }
}


/* ============================================================
 * NET OUT / PROFIT-LOSS PERCENTAGE
 * ============================================================ */

/*
 * Net Out % is now based ONLY on the net result.
 *
 * Positive = profit
 * Negative = loss
 *
 * Formula:
 *
 *   net / moneyIn * 100
 *
 * Examples:
 *
 *   Money In $100
 *   Money Out $80
 *   Net $20
 *   Net Out % = +20%
 *
 *   Money In $100
 *   Money Out $120
 *   Net -$20
 *   Net Out % = -20%
 *
 * If there is no money in, percentage is 0 because there is
 * no meaningful revenue/income base.
 */
function calculateNetOutPercent(
  moneyIn,
  net
) {
  if (
    !moneyIn
  ) {
    return 0;
  }

  return round(
    (net / moneyIn) *
      100
  );
}


function newMonth() {
  return {
    transactions: 0,
    moneyIn: 0,
    moneyOut: 0,
    net: 0,
    netOutPercent: 0,
    people: {},
  };
}


function calculate(
  transactions
) {
  const overall = {
    transactions:
      transactions.length,

    moneyIn: 0,

    moneyOut: 0,

    net: 0,

    netOutPercent: 0,
  };


  const months =
    {};

  const people =
    {};


  for (const tx of transactions) {

    const amount =
      Number(tx.amount) || 0;


    /*
     * Month.
     */
    if (!months[tx.month]) {
      months[tx.month] =
        newMonth();
    }

    const month =
      months[tx.month];

    month.transactions++;


    /*
     * Net.
     */
    overall.net =
      round(
        overall.net +
          amount
      );

    month.net =
      round(
        month.net +
          amount
      );


    /*
     * Money in/out.
     */
    if (
      amount > 0
    ) {

      overall.moneyIn =
        round(
          overall.moneyIn +
            amount
        );

      month.moneyIn =
        round(
          month.moneyIn +
            amount
        );

    } else if (
      amount < 0
    ) {

      overall.moneyOut =
        round(
          overall.moneyOut +
            Math.abs(amount)
        );

      month.moneyOut =
        round(
          month.moneyOut +
            Math.abs(amount)
        );
    }


    /*
     * People.
     *
     * IMPORTANT:
     *
     * Only actual Cash App person-to-person payments with a
     * detected person are included.
     */
    /*
 * People.
 *
 * ONLY transactions explicitly classified as:
 *
 *   category === "person"
 *
 * are allowed here.
 *
 * This prevents:
 *
 *   Bank transfers
 *   Savings transfers
 *   Card purchases
 *   Bitcoin
 *   Cash App Pay
 *   Deposits
 *
 * from appearing as people.
 */
if (
  tx.category === "person" &&
  tx.person &&
  !isNonPerson(tx.person)
) {
  addToPerson(
    people,
    tx.person,
    amount
  );

  addToPerson(
    month.people,
    tx.person,
    amount
  );
}
  }


  /*
   * Net Out % / Profit-Loss %.
   */
  overall.netOutPercent =
    calculateNetOutPercent(
      overall.moneyIn,
      overall.net
    );


  for (
    const month of
    Object.values(months)
  ) {

    month.netOutPercent =
      calculateNetOutPercent(
        month.moneyIn,
        month.net
      );
  }


  return {
    overall,
    months,
    people,
  };
}


/* ============================================================
 * SORT PEOPLE
 * ============================================================ */

function sortPeople(
  people
) {
  return Object.entries(
    people
  )
    .map(
      ([person, data]) => ({
        person,
        ...data,
      })
    )
    .sort(
      (a, b) =>
        b.sent +
        b.received -
        (a.sent +
          a.received)
    );
}


/* ============================================================
 * PARSED TOTALS
 * ============================================================ */

function calculateParsedTotals(
  transactions
) {
  let moneyIn =
    0;

  let moneyOut =
    0;


  for (
    const tx of
    transactions
  ) {

    if (
      tx.amount > 0
    ) {

      moneyIn +=
        tx.amount;

    } else {

      moneyOut +=
        Math.abs(
          tx.amount
        );
    }
  }


  return {
    moneyIn:
      round(moneyIn),

    moneyOut:
      round(moneyOut),

    net:
      round(
        moneyIn -
          moneyOut
      ),
  };
}


/* ============================================================
 * RECONCILIATION
 * ============================================================ */

function reconciliation(
  statement,
  parsed
) {
  const statementNet =
    statement.moneyIn !== null &&
    statement.moneyOut !== null
      ? round(
          statement.moneyIn -
            statement.moneyOut
        )
      : null;


  const parsedNet =
    round(
      parsed.moneyIn -
        parsed.moneyOut
    );


  const result = {
    statementMoneyIn:
      statement.moneyIn,

    parsedMoneyIn:
      parsed.moneyIn,

    moneyInDifference:
      null,

    /*
     * Keep these internally for reconciliation.
     * Money Out is no longer displayed in the report.
     */
    statementMoneyOut:
      statement.moneyOut,

    parsedMoneyOut:
      parsed.moneyOut,

    moneyOutDifference:
      null,

    statementNet,

    parsedNet,

    netDifference:
      null,

    matches:
      null,
  };


  if (
    statement.moneyIn !==
    null
  ) {

    result.moneyInDifference =
      round(
        parsed.moneyIn -
          statement.moneyIn
      );
  }


  if (
    statement.moneyOut !==
    null
  ) {

    result.moneyOutDifference =
      round(
        parsed.moneyOut -
          statement.moneyOut
      );
  }


  if (
    statementNet !== null
  ) {

    result.netDifference =
      round(
        parsedNet -
          statementNet
      );
  }


  const inMatches =
    result.moneyInDifference ===
      null ||
    Math.abs(
      result.moneyInDifference
    ) < 0.01;


  const outMatches =
    result.moneyOutDifference ===
      null ||
    Math.abs(
      result.moneyOutDifference
    ) < 0.01;


  result.matches =
    inMatches &&
    outMatches;


  return result;
}


/* ============================================================
 * CSV
 * ============================================================ */

function csv(value) {
  return `"${String(
    value ?? ""
  ).replace(
    /"/g,
    '""'
  )}"`;
}


function makeSummaryCSV(
  summary
) {
  const rows =
    [];

  rows.push([
    "Scope",
    "Month",
    "Person",
    "Transactions",
    "Money In",
    "Money Out",
    "Net",
    "Net Out %",
  ]);


  rows.push([
    "Overall",
    "",
    "",
    summary.overall
      .transactions,
    summary.overall
      .moneyIn,
    summary.overall
      .moneyOut,
    summary.overall.net,
    summary.overall
      .netOutPercent,
  ]);


  for (
    const month of
    Object.keys(
      summary.months
    ).sort()
  ) {

    const m =
      summary.months[
        month
      ];


    rows.push([
      "Month",
      month,
      "",
      m.transactions,
      m.moneyIn,
      m.moneyOut,
      m.net,
      m.netOutPercent,
    ]);


    for (
      const p of
      sortPeople(
        m.people
      )
    ) {

      rows.push([
        "Month/Person",
        month,
        p.person,
        p.transactions,
        p.received,
        p.sent,
        p.net,
        "",
      ]);
    }
  }


  for (
    const p of
    sortPeople(
      summary.people
    )
  ) {

    rows.push([
      "Overall/Person",
      "",
      p.person,
      p.transactions,
      p.received,
      p.sent,
      p.net,
      "",
    ]);
  }


  return rows
    .map(row =>
      row
        .map(csv)
        .join(",")
    )
    .join("\n");
}


function makeTransactionCSV(
  transactions
) {
  const rows =
    [];


  rows.push([
    "Date",
    "Month",
    "Type",
    "Category",
    "Person",
    "Description",
    "Details",
    "Fee",
    "Amount",
    "Source File",
  ]);


  for (
    const tx of
    transactions
  ) {

    rows.push([
      tx.date,
      tx.month,
      tx.type,
      tx.category,
      tx.person || "",
      tx.description,
      tx.details || "",
      tx.fee,
      tx.amount,
      tx.sourceFile,
    ]);
  }


  return rows
    .map(row =>
      row
        .map(csv)
        .join(",")
    )
    .join("\n");
}


/* ============================================================
 * CONSOLE DISPLAY HELPERS
 * ============================================================ */

function line(
  char = "=",
  length = 80
) {
  return char.repeat(length);
}


function section(title) {
  console.log();
  console.log(
    line("=")
  );
  console.log(
    ` ${title}`
  );
  console.log(
    line("=")
  );
}


function printMoneyRow(
  label,
  value
) {
  console.log(
    `${label.padEnd(22)} ${moneyDisplay(value)}`
  );
}


/* ============================================================
 * DISPLAY OVERALL
 * ============================================================ */

function printOverall(
  summary
) {
  section(
    "OVERALL SUMMARY"
  );


  console.log(
    `Transactions`.padEnd(22) +
    summary.overall.transactions
  );

  printMoneyRow(
    "Money In",
    summary.overall.moneyIn
  );

  printMoneyRow(
    "Money Out",
    summary.overall.moneyOut
  );

  printMoneyRow(
    "Net",
    summary.overall.net
  );

  console.log(
    `Net Out %`.padEnd(22) +
    `${summary.overall.netOutPercent.toFixed(2)}%`
  );
}


/* ============================================================
 * DISPLAY PEOPLE
 * ============================================================ */

function printPeople(
  summary
) {
  section(
    "PERSON-TO-PERSON ACTIVITY"
  );


  const people =
    sortPeople(
      summary.people
    );


  if (!people.length) {
    console.log(
      "No person-to-person transactions detected."
    );

    return;
  }


  console.log(
    [
      "Person".padEnd(30),
      "Sent".padStart(14),
      "Received".padStart(14),
      "Net".padStart(14),
      "Txns".padStart(7),
    ].join(" ")
  );


  console.log(
    line("-", 82)
  );


  for (
    const p of people
  ) {

    console.log(
      [
        p.person
          .substring(0, 30)
          .padEnd(30),

        moneyDisplay(p.sent)
          .padStart(14),

        moneyDisplay(p.received)
          .padStart(14),

        moneyDisplay(p.net)
          .padStart(14),

        String(
          p.transactions
        ).padStart(7),
      ].join(" ")
    );
  }
}


/* ============================================================
 * DISPLAY MONTHS
 * ============================================================ */

function printMonthly(
  summary
) {
  section(
    "MONTHLY SUMMARY"
  );


  for (
    const month of
    Object.keys(
      summary.months
    ).sort()
  ) {

    const m =
      summary.months[
        month
      ];


    console.log();
    console.log(
      ` ${month}`
    );
    console.log(
      line("-", 50)
    );


    console.log(
      `Transactions`.padEnd(22) +
      m.transactions
    );

    printMoneyRow(
      "Money In",
      m.moneyIn
    );

    printMoneyRow(
      "Money Out",
      m.moneyOut
    );

    printMoneyRow(
      "Net",
      m.net
    );

    console.log(
      `Net Out %`.padEnd(22) +
      `${m.netOutPercent.toFixed(2)}%`
    );


    const people =
      sortPeople(
        m.people
      );


    if (people.length) {

      console.log();
      console.log(
        "  People:"
      );


      for (
        const p of people
      ) {

        console.log(
          `    ${p.person}: ` +
          `sent ${moneyDisplay(
            p.sent
          )}, ` +
          `received ${moneyDisplay(
            p.received
          )}, ` +
          `net ${moneyDisplay(
            p.net
          )}`
        );
      }
    }
  }
}


/* ============================================================
 * DISPLAY ALL TRANSACTIONS
 * ============================================================ */

function printTransactions(
  transactions
) {
  section(
    `ALL TRANSACTIONS (${transactions.length})`
  );


  if (!transactions.length) {
    console.log(
      "No transactions parsed."
    );

    return;
  }


  transactions.forEach(
    (tx, index) => {

      const direction =
        tx.type ===
        "received"
          ? "IN "
          : "OUT";

      console.log(
        `${String(
          index + 1
        ).padStart(4)}. ${tx.person && `${String(tx.person).padStart(10)}` || ''}\n      [${tx.date}]${moneyDisplay(tx.amount).padStart(10)} ${tx.fee ? `(${moneyDisplay(tx.fee)} fee)` : ``}`
      );

      console.log(
        `      Type        : ${
          tx.details || "(none)"
        }`
      );


      console.log(
        `      Description : ${
          tx.description || "(none)"
        }`
      );


      /*console.log(
        `      Category    : ${
          tx.category
        }`
      );*/




      /*console.log(
        `      Fee         : ${
          moneyDisplay(tx.fee)
        }`
      );*/


      console.log(
        `      File        : ${
          tx.sourceFile
        }\n`
      );
    }
  );
}


/* ============================================================
 * FILE RECONCILIATION
 * ============================================================ */
const MONTHSR = {
  0: 'Jan',
  1: 'Feb',
  2: 'Mar',
  3: 'Apr',
  4: 'May',
  5: 'Jun',
  6: 'Jul',
  7: 'Aug',
  8: 'Sep',
  9: 'Oct',
  10: 'Nov',
  11: 'Dec',
};
function printReconciliation(
  reports
) {
  section(
    "FILE RECONCILIATION"
  );


  for (
    const report of
    reports
  ) {

    console.log();
    console.log(
      ` [${report.date.substring(0,4)} ${MONTHSR[Number(report.date.substring(5,7))]}]`
    );


    if (report.error) {

      console.log(
        `   ERROR: ${report.error}`
      );

      continue;
    }


    const r =
      report.reconciliation;


    console.log(
      `   Type         : ${
        report.type
      }`
    );


    console.log(
      `   Transactions : ${
        report.transactions
      }`
    );

    /*
     * Money In.
     */
    if (
      r.statementMoneyIn !==
      null
    ) {

      console.log(
        `   Money        : in ${
          moneyDisplay(
            r.statementMoneyIn
          )
        } | out ${
          moneyDisplay(
            r.statementMoneyOut
          )
        }`
      );
    }


    /*
     * Net replaces Money Out in the displayed reconciliation.
     *
     * Example:
     *
     * Net          : statement $0.00 | parsed $0.00 | difference $0.00
     */
    if (
      r.statementNet !==
      null
    ) {

      console.log(
        `   Net          : ${
          moneyDisplay(
	    r.parsedMoneyIn - r.parsedMoneyOut
            //r.netDifference
          )
        }`
      );
    }
  }
}


/* ============================================================
 * PRINT COMPLETE REPORT
 * ============================================================ */

function printReport(
  summary,
  transactions,
  reports,
  pdfFiles
) {



console.log(`Bank Statements Processed  ${pdfFiles.length}`);

  printPeople(
    summary
  );

  printMonthly(
    summary
  );

  printTransactions(
    transactions
  );

  printReconciliation(
    reports
  );

  printOverall(
    summary
  );

  

  console.log();
  console.log(
    line("=")
  );
}


/* ============================================================
 * MAIN
 * ============================================================ */

async function main() {

  console.log(
    "\nCash App PDF Parser"
  );

  console.log(
    `Directory: ${INPUT_DIR}`
  );


  /*
   * ----------------------------------------------------------
   * FIND EVERY PDF
   * ----------------------------------------------------------
   */
  const pdfFiles =
    fs
      .readdirSync(
        INPUT_DIR
      )
      .filter(
        file =>
          file
            .toLowerCase()
            .endsWith(".pdf")
      )
      .sort(
        (a, b) =>
          a.localeCompare(
            b,
            undefined,
            {
              numeric: true,
            }
          )
      );


  if (!pdfFiles.length) {

    console.log();
    console.log(
      "No PDF files found."
    );

    console.log(
      "Place your Cash App PDFs in:"
    );

    console.log(
      INPUT_DIR
    );

    return;
  }


  console.log();
  console.log(
    `Found ${pdfFiles.length} PDF file(s).`
  );


  const allTransactions =
    [];

  const fileReports =
    [];


  /*
   * ----------------------------------------------------------
   * PROCESS EVERY PDF
   * ----------------------------------------------------------
   */
  for (
    const file of pdfFiles
  ) {

    const fullPath =
      path.join(
        INPUT_DIR,
        file
      );


    /*console.log();
    console.log(
      `${file}`
    );*/


    try {

      const pdf =
        await loadPdf(
          fs.readFileSync(
            fullPath
          )
        );


      const text =
        pdf.text;


      /*
       * Determine statement type.
       */
      const savings =
        /Savings\s+Statement/i.test(
          text
        );


      /*
       * Statement totals.
       */
      const statementTotals =
        getStatementTotals(
          text
        );


      /*
       * Account and savings statements share an identical row
       * layout ([Date][Description][Marker][Fee][Amount]), so a
       * single parser handles both. The statement "type" above
       * is retained only for reporting.
       */
      const transactions =
        parseRegularStatement(
          text,
          file
        );


      /*
       * Parsed totals.
       */
      const parsedTotals =
        calculateParsedTotals(
          transactions
        );


      /*
       * Reconciliation.
       */
      const recon =
        reconciliation(
          statementTotals,
          parsedTotals
        );

/*console.log(
        `  Net: ${
          moneyDisplay(
            parsedTotals.net
          )
        }\t(${
          moneyDisplay(
            parsedTotals.moneyIn
          )
        } - ${
          moneyDisplay(
            parsedTotals.moneyOut
          )
        })`
      );
      console.log(
        `  ${
          savings
            ? "Savings Statement"
            : "Account Statement"
        } - ${String(transactions.length).padStart(1)} transactions`
      );

      

      console.log(
        `  Reconciliation: ${
          recon.matches
            ? "✓ MATCH"
            : "✗ MISMATCH"
        }`
      );
*/


      allTransactions.push(
        ...transactions
      );


      fileReports.push({
	date: transactions[0].date, 
        file,

        pages:
          pdf.numpages,

        type:
          savings
            ? "savings"
            : "account",

        statementTotals,

        parsedTotals,

        reconciliation:
          recon,

        transactions:
          transactions.length,
      });

    } catch (err) {

      console.error(
        `  ERROR: ${err.message}`
      );


      fileReports.push({
        file,

        error:
          err.message,
      });
    }
  }


  /*
   * ----------------------------------------------------------
   * REMOVE EXACT DUPLICATES
   * ----------------------------------------------------------
   */
  const seen =
    new Set();


  const transactions =
    allTransactions.filter(
      tx => {

        const key =
          [
            tx.sourceFile,
            tx.date,
            tx.type,
            tx.person,
            tx.description,
            tx.details,
            tx.fee,
            tx.amount,
          ].join("|");


        if (
          seen.has(key)
        ) {
          return false;
        }


        seen.add(key);

        return true;
      }
    );


  /*
   * ----------------------------------------------------------
   * SORT CHRONOLOGICALLY
   * ----------------------------------------------------------
   */
  transactions.sort(
    (a, b) => {

      const dateCompare =
        a.date.localeCompare(
          b.date
        );


      if (
        dateCompare !== 0
      ) {
        return dateCompare;
      }


      return a.sourceFile.localeCompare(
        b.sourceFile
      );
    }
  );


  /*
   * ----------------------------------------------------------
   * CALCULATE SUMMARY
   * ----------------------------------------------------------
   */
  const summary =
    calculate(
      transactions
    );


  /*
   * ----------------------------------------------------------
   * JSON OUTPUT
   * ----------------------------------------------------------
   */
  const output = {

    generatedAt:
      new Date().toISOString(),

    inputDirectory:
      INPUT_DIR,

    filesProcessed:
      pdfFiles.length,

    overall:
      summary.overall,

    peopleOverall:
      sortPeople(
        summary.people
      ),

    monthly:
      Object.keys(
        summary.months
      )
        .sort()
        .map(
          month => ({
            month,

            ...summary.months[
              month
            ],

            people:
              sortPeople(
                summary.months[
                  month
                ].people
              ),
          })
        ),

    files:
      fileReports,

    transactions,
  };


  fs.writeFileSync(
    JSON_OUTPUT,
    JSON.stringify(
      output,
      null,
      2
    )
  );


  /*
   * ----------------------------------------------------------
   * CSV OUTPUT
   * ----------------------------------------------------------
   */
  fs.writeFileSync(
    CSV_OUTPUT,
    makeSummaryCSV(
      summary
    )
  );


  fs.writeFileSync(
    TRANSACTION_CSV_OUTPUT,
    makeTransactionCSV(
      transactions
    )
  );


  /*
   * ----------------------------------------------------------
   * DISPLAY EVERYTHING
   * ----------------------------------------------------------
   */
  printReport(
    summary,
    transactions,
    fileReports,
    pdfFiles
  );
}


/* ============================================================
 * START
 * ============================================================ */

main().catch(
  error => {

    console.error();

    console.error(
      "FATAL ERROR:"
    );

    console.error(
      error
    );

    process.exit(1);
  }
);
