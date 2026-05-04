require("dotenv").config();
const fs = require("fs");
const { chromium } = require("playwright");

const INGEST_URL = process.env.INGEST_URL;
const INGEST_TOKEN = process.env.INGEST_TOKEN;
const HEADLESS = true; // set true in GitHub Actions later

function currencyForDestination(destination) {
  if (destination === "GH") return "GHS";
  if (destination === "NG") return "NGN";
  return "GHS";
}

async function postQuote(payload) {
  if (
    !INGEST_URL ||
    !INGEST_TOKEN ||
    INGEST_URL.includes("your-quoteops-app-url") ||
    INGEST_TOKEN.includes("your_secret_token_here")
  ) {
    console.log("INGEST_URL or INGEST_TOKEN not set. Quote extracted locally only:");
    console.log(payload);
    return;
  }

  const res = await fetch(INGEST_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${INGEST_TOKEN}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Ingest failed: ${res.status} ${text}`);
  }
}

function saveDebugText() {
  
}

async function saveScreenshot(page, provider) {
  const safe = provider.replace(/\s+/g, "-").toLowerCase();
  const file = `debug-${safe}.png`;
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

function parseLocaleNumber(value) {
  if (value === null || value === undefined) return null;

  let str = String(value).trim();
  if (!str) return null;

  str = str.replace(/[^\d,.-]/g, "");

  const hasComma = str.includes(",");
  const hasDot = str.includes(".");

  if (hasComma && hasDot) {
    const lastComma = str.lastIndexOf(",");
    const lastDot = str.lastIndexOf(".");

    if (lastComma > lastDot) {
      str = str.replace(/\./g, "").replace(",", ".");
    } else {
      str = str.replace(/,/g, "");
    }
  } else if (hasComma) {
    if (/,\d{1,2}$/.test(str)) {
      str = str.replace(",", ".");
    } else {
      str = str.replace(/,/g, "");
    }
  } else if (hasDot) {
    const parts = str.split(".");
    if (parts.length > 2) {
      const decimal = parts.pop();
      str = parts.join("") + "." + decimal;
    }
  }

  const num = Number(str);
  return Number.isFinite(num) ? num : null;
}

function extractRateFromText(text, currency) {
  const cleaned = text.replace(/,/g, "").replace(/\s+/g, " ");

  const patterns = [
    new RegExp(`1\\s*GBP\\s*=\\s*([0-9.]+)\\s*${currency}`, "i"),
    new RegExp(`GBP\\s*1\\s*=\\s*([0-9.]+)\\s*${currency}`, "i"),
    new RegExp(`Exchange Rate\\s*1\\s*GBP\\s*=\\s*([0-9.]+)\\s*${currency}`, "i"),
    new RegExp(`Today[’']s rate:\\s*1(?:\\.00)?\\s*GBP\\s*=\\s*([0-9.]+)\\s*${currency}`, "i"),
    new RegExp(`rate:?\\s*1\\s*GBP\\s*=\\s*([0-9.]+)\\s*${currency}`, "i"),
    new RegExp(`([0-9]+(?:\\.[0-9]+)?)\\s*${currency}`, "i"),
  ];

  for (const regex of patterns) {
    const match = cleaned.match(regex);
    if (match) {
      const value = Number(match[1]);
      if (Number.isFinite(value) && value > 0 && value < 100) {
        return value;
      }
    }
  }

  return null;
}

function extractFeeFromText(text, sourceCurrency = "GBP") {
  const cleaned = text.replace(/,/g, "").replace(/\s+/g, " ");

  const patterns = [
    new RegExp(`Transfer fees?:\\s*([0-9.]+)\\s*${sourceCurrency}`, "i"),
    new RegExp(`Fees?:\\s*([0-9.]+)\\s*${sourceCurrency}`, "i"),
    new RegExp(`Zero`, "i"),
    new RegExp(`No transfer fees`, "i"),
  ];

  for (const regex of patterns) {
    const match = cleaned.match(regex);
    if (!match) continue;
    if (/Zero/i.test(match[0]) || /No transfer fees/i.test(match[0])) return 0;
    if (match[1]) return Number(match[1]);
  }

  return 0;
}

function extractAmountReceivedFromText(text, currency) {
  const cleaned = text.replace(/,/g, "").replace(/\s+/g, " ");

  const patterns = [
    new RegExp(`Recipient gets\\s*([0-9.]+)\\s*${currency}`, "i"),
    new RegExp(`They get\\s*([0-9.]+)\\s*${currency}`, "i"),
    new RegExp(`You receive\\s*([0-9.]+)\\s*${currency}`, "i"),
    new RegExp(`You get\\s*([0-9.]+)\\s*${currency}`, "i"),
    new RegExp(`Receive amount\\s*([0-9.]+)\\s*${currency}`, "i"),
    new RegExp(`([0-9.]+)\\s*${currency}`, "i"),
  ];

  for (const regex of patterns) {
    const match = cleaned.match(regex);
    if (match && match[1]) return Number(match[1]);
  }

  return null;
}

function buildPayloadFromText(source, bodyText) {
  const currency = currencyForDestination(source.destination);
  const sendAmount = Number(source.send_amount || 1);

  let rate = extractRateFromText(bodyText, currency);
  const fee = extractFeeFromText(bodyText, "GBP");
  let amountReceived = extractAmountReceivedFromText(bodyText, currency);

  if (!rate && amountReceived && sendAmount > 0) {
    rate = Number((amountReceived / sendAmount).toFixed(6));
  }

  if (!amountReceived && rate) {
    amountReceived = Number((rate * sendAmount).toFixed(3));
  }

  if (!rate || !amountReceived) return null;

  return {
    provider_name: source.provider,
    origin_country: source.origin,
    destination_country: source.destination,
    payout_method: source.payout_method,
    send_amount: sendAmount,
    exchange_rate: rate,
    fee,
    amount_received: Number(amountReceived.toFixed(3)),
    delivery_speed: null,
    source_type: "browser_automation",
    verification_status: "verified_from_quote_page",
    source_url: source.url,
    checked_at: new Date().toISOString(),
  };
}

function buildResult(source, rate, fee = 0, amountReceived = null, extra = {}) {
  const sendAmount = Number(source.send_amount || 1);
  const normalizedAmountReceived =
    amountReceived !== null && amountReceived !== undefined
      ? Number(Number(amountReceived).toFixed(6))
      : Number(Number(rate).toFixed(6));

  return {
    provider_name: source.provider,
    origin_country: source.origin,
    destination_country: source.destination,
    payout_method: source.payout_method,
    send_amount: sendAmount,
    exchange_rate: Number(Number(rate).toFixed(6)),
    fee: Number(Number(fee || 0).toFixed(6)),
    amount_received: normalizedAmountReceived,
    delivery_speed: null,
    source_type: "browser_automation",
    verification_status: "verified_from_quote_page",
    source_url: source.url,
    checked_at: new Date().toISOString(),
    ...extra,
  };
}

async function handleLemFi(page, source) {
  await page.goto("https://lemfi.com/en-gb/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(4000);

  await page.getByRole("button", { name: /Accept all cookies/i }).click({ timeout: 5000 }).catch(() => {});
  await page.getByRole("button", { name: /Accept all/i }).click({ timeout: 5000 }).catch(() => {});
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(1500);

  await page.locator("div").filter({ hasText: /^GBP$/ }).first().click({ force: true }).catch(async () => {
    await page.locator("div").filter({ hasText: /^[A-Z]{3}$/ }).first().click({ force: true });
  });

  let searchInput = page.getByPlaceholder("Enter currency or country").last();
  await searchInput.waitFor({ timeout: 10000 });
  await searchInput.fill("gbp");
  await page.waitForTimeout(1000);
  await page.getByText("United Kingdom", { exact: true }).click().catch(async () => {
    await page.getByText(/United Kingdom/i).first().click();
  });

  await page.waitForTimeout(1500);

  await page.locator("div").filter({ hasText: /^EUR$/ }).first().click({ force: true }).catch(async () => {
    const selectors = page.locator("div").filter({ hasText: /^[A-Z]{3}$/ });
    const count = await selectors.count();
    if (count >= 2) {
      await selectors.nth(1).click({ force: true });
    } else {
      await selectors.first().click({ force: true });
    }
  });

  searchInput = page.getByPlaceholder("Enter currency or country").last();
  await searchInput.waitFor({ timeout: 10000 });
  await searchInput.fill("ghan");
  await page.waitForTimeout(1000);

  await page.getByText("GHS - Ghanian Cedis").click().catch(async () => {
    await page.getByText(/GHS/i).first().click();
  });

  await page.waitForTimeout(1500);

  const sendBox = page.getByRole("textbox", { name: /You send/i });
  await sendBox.waitFor({ timeout: 10000 });
  await sendBox.click({ force: true });
  await sendBox.press("Control+A").catch(() => {});
  await sendBox.fill("1");

  await page.waitForTimeout(5000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  const payload = buildPayloadFromText(source, bodyText);
  if (!payload) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract LemFi rate. Screenshot: ${file}`);
  }

  return payload;
}

async function handleSendwave(page, source) {
  await page.goto("https://www.sendwave.com/en-gb", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(3000);

  const sendInput = page.getByRole("textbox", { name: "exchange-calculator-send-" });
  await sendInput.waitFor({ timeout: 10000 });

  await page
    .getByTestId("exchange-calculator-send-country-select")
    .getByTestId("ExpandMoreRoundedIcon")
    .click();

  await page.getByRole("combobox", { name: "Search" }).fill("gbp");
  await page.getByText("United KingdomGBP").click();

  await page.waitForTimeout(1000);

  await page.getByTestId("exchange-calculator-receive-country-select").click();
  await page.getByRole("combobox", { name: "Search" }).fill("ghana");
  await page.locator("div").filter({ hasText: /^GhanaGHS$/ }).click();

  await page.waitForTimeout(1000);

  await sendInput.click();
  await sendInput.fill("1");

  await page.waitForTimeout(4000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  const payload = buildPayloadFromText(source, bodyText);
  if (!payload) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract Sendwave rate. Screenshot: ${file}`);
  }
  return payload;
}

async function handleTapTap(page, source) {
  await page.goto("https://www.taptapsend.com/en-gb", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(3000);

  await page.getByRole("button", { name: "Close Cookie Popup" }).click({ timeout: 10000 }).catch(() => {});
  await page.locator("#destination-currency").selectOption("GH-GHS-DESTINATION");
  await page.waitForTimeout(1000);

  const amountInput = page.getByPlaceholder("100");
  await amountInput.waitFor({ timeout: 10000 });
  await amountInput.click();
  await amountInput.fill("1");

  await page.waitForTimeout(4000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  const payload = buildPayloadFromText(source, bodyText);
  if (!payload) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract TapTap Send rate. Screenshot: ${file}`);
  }
  return payload;
}

async function handleTransferGo(page, source) {
  const scrapeAmount = 100;

  await page.goto("https://www.transfergo.com/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(5000);

  await page
    .getByRole("button", { name: /Accept all/i })
    .click({ timeout: 10000 })
    .catch(() => {});

  await page.waitForTimeout(1500);

  await page
    .getByRole("button", { name: "Sending currency button." })
    .click({ force: true });

  await page.waitForTimeout(1000);

  await page
    .getByRole("option", { name: /Popular sending option: GBP/i })
    .click({ timeout: 10000 });

  await page.waitForTimeout(1000);

  await page
    .getByRole("button", { name: "Receiving currency button." })
    .click({ force: true });

  await page.waitForTimeout(1000);

  const receivingSearch = page.getByRole("textbox", {
    name: "Receiving currency search.",
  });
  await receivingSearch.waitFor({ timeout: 10000 });
  await receivingSearch.fill("gh");

  await page.waitForTimeout(1000);

  await page
    .getByRole("option", { name: /Currency receiving option: GHS in Ghana/i })
    .click({ timeout: 10000 });

  await page.waitForTimeout(2500);

  const sendBox = page.locator("#sending-currency-amount");
  await sendBox.waitFor({ timeout: 10000 });

  await sendBox.click({ force: true });
  await sendBox.press("Control+A").catch(() => {});
  await sendBox.press("Meta+A").catch(() => {});
  await sendBox.fill("");
  await sendBox.type(String(scrapeAmount), { delay: 50 });

  await page.waitForTimeout(7000);

  const receiveBox = page.locator("#receiving-currency-amount");

  let amountReceivedTotal = null;
  if (await receiveBox.count()) {
    const rawReceive = await receiveBox.inputValue().catch(() => "");
    const parsedReceive = parseLocaleNumber(rawReceive);

    if (parsedReceive && parsedReceive > 0) {
      amountReceivedTotal = parsedReceive;
    }
  }

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  let rate = null;

  if (amountReceivedTotal && scrapeAmount > 0) {
    rate = Number((amountReceivedTotal / scrapeAmount).toFixed(6));
  }

  if (!rate) {
    const patterns = [
      /Exchange Rate[^0-9]*GBP\s*1\s*=\s*GHS\s*([\d.,\s]+)/i,
      /GBP\s*1\s*=\s*GHS\s*([\d.,\s]+)/i,
      /1\s*GBP\s*=\s*([\d.,\s]+)\s*GHS/i,
      /Rate[^0-9]*([\d.,\s]+)\s*GHS/i,
    ];

    for (const regex of patterns) {
      const match = bodyText.match(regex);
      if (!match) continue;

      const candidate = parseLocaleNumber(match[1] || match[0]);
      if (candidate && candidate > 0) {
        rate = Number(candidate.toFixed(6));
        break;
      }
    }
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract TransferGo rate. Screenshot: ${file}`);
  }

  return {
    provider_name: source.provider,
    origin_country: source.origin,
    destination_country: source.destination,
    payout_method: source.payout_method,
    send_amount: 1,
    exchange_rate: rate,
    amount_received: Number(rate.toFixed(6)),
    fee: 0,
    delivery_speed: null,
    source_type: "browser_automation",
    verification_status: "verified_from_quote_page",
    source_url: source.url,
    checked_at: new Date().toISOString(),
    quoted_send_amount: scrapeAmount,
    quoted_amount_received: amountReceivedTotal,
  };
}

async function handlePayAngel(page, source) {
  await page.goto("https://payangel.com/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(4000);

  await page.getByRole("button", { name: /Close dialogue/i }).click({ timeout: 5000 }).catch(() => {});
  await page.getByRole("button", { name: /^Close$/i }).click({ timeout: 5000 }).catch(() => {});
  await page.keyboard.press("Escape").catch(() => {});

  await page.getByRole("link", { name: /Check today’s rate/i }).click();
  await page.waitForTimeout(2000);

  await page.getByRole("button", { name: /USD|GBP/i }).first().click().catch(() => {});
  await page.getByText(/^GBP$/).click().catch(async () => {
    await page.getByRole("option", { name: /^GBP$/i }).click().catch(() => {});
  });

  await page.waitForTimeout(1000);

  const sendInput = page.getByRole("spinbutton", { name: /You send/i });
  await sendInput.waitFor({ timeout: 10000 });
  await sendInput.click({ force: true });
  await sendInput.press("Control+A").catch(() => {});
  await sendInput.fill("1");

  await page.locator(".rc-body").click({ timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(4000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  let rate = null;

  const patterns = [
    /([0-9]+(?:\.[0-9]+)?)\s*GHS/i,
    /1\s*GBP\s*=\s*([0-9.]+)\s*GHS/i,
    /GBP\s*1\s*=\s*([0-9.]+)\s*GHS/i,
  ];

  for (const regex of patterns) {
    const match = bodyText.match(regex);
    if (!match) continue;
    const candidate = parseLocaleNumber(match[1]);
    if (candidate && candidate > 0 && candidate < 100) {
      rate = candidate;
      break;
    }
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract PayAngel rate. Screenshot: ${file}`);
  }

  return buildResult(source, rate, 0, rate);
}

async function handleRemitChoice(page, source) {
  await page.goto("https://www.remitchoice.com/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(5000);

  await page.getByRole("textbox", { name: /Australia|United Kingdom/i }).click();
  await page.getByRole("searchbox", { name: /Search/i }).fill("un");
  await page.waitForTimeout(1200);

  await page
    .locator('#select2-sendingcountry-results, [id*="select2-sendingcountry"]')
    .getByText(/United Kingdom/i)
    .click()
    .catch(async () => {
      await page.getByRole("option", { name: /United Kingdom/i }).click().catch(async () => {
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("Enter");
      });
    });

  await page.waitForTimeout(1200);

  await page.getByRole("textbox", { name: /Austria|Ghana/i }).click();
  await page.getByRole("searchbox", { name: /Search/i }).fill("gh");
  await page.waitForTimeout(1200);

  await page.getByRole("option", { name: /Ghana/i }).click().catch(async () => {
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
  });

  await page.waitForTimeout(1000);

  await page.getByRole("button", { name: /Proceed/i }).click();
  await page.waitForTimeout(5000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  let rate = null;
  const patterns = [
    /Exchange Rate\s*1\s*GBP\s*=\s*([0-9.]+)/i,
    /1\s*GBP\s*=\s*([0-9.]+)\s*GHS/i,
    /\b(1[0-9]\.\d{2,5})\b/,
  ];

  for (const regex of patterns) {
    const match = bodyText.match(regex);
    if (!match) continue;
    const candidate = parseLocaleNumber(match[1] || match[0]);
    if (candidate && candidate > 0 && candidate < 100) {
      rate = candidate;
      break;
    }
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract RemitChoice rate. Screenshot: ${file}`);
  }

  return buildResult(source, rate, 0, rate);
}

async function handleRizRemit(page, source) {
  await page.goto("https://rizremit.com/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(4000);

  await page.getByRole("combobox", { name: "United Kingdom" }).click();
  await page.getByRole("searchbox", { name: "Search" }).fill("uni");
  await page.waitForTimeout(1000);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");

  await page.getByRole("textbox", { name: "Sending To" }).click();
  await page.getByRole("searchbox", { name: "Search" }).fill("gh");
  await page.waitForTimeout(1000);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");

  await page.getByRole("button", { name: "Send Now!" }).click();
  await page.waitForTimeout(2000);

  await page.goto("https://rizremit.com/en-uk/send-money-to-ghana?sending=GB", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(3000);

  await page.locator("#select2-sending-container").click().catch(async () => {
    await page.locator(".select2-selection").first().click();
  });
  await page.getByRole("searchbox", { name: "Search" }).fill("un");
  await page.waitForTimeout(1000);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");

  await page.locator("#select2-receiving-container").click();
  await page.getByRole("searchbox", { name: "Search" }).fill("gh");
  await page.waitForTimeout(1000);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");

  await page.locator("#youSend").click();
  await page.locator("#youSend").fill("1");

  await page.getByRole("textbox", { name: "Premium Rate" }).click().catch(() => {});
  await page.getByRole("searchbox", { name: "Search" }).fill("st").catch(() => {});
  await page.getByText("Standard Rate - Zero Fee").click().catch(() => {});

  await page.waitForTimeout(5000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  const payload = buildPayloadFromText(source, bodyText);
  if (!payload) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract RizRemit rate. Screenshot: ${file}`);
  }
  return payload;
}

async function handleNala(page, source) {
  await page.goto("https://www.nala.com/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(5000);

  await page.getByRole("button", { name: "Select currency" }).nth(1).click({
    timeout: 15000,
  });

  await page
    .getByRole("option", { name: /Ghanaian Cedi GHS/i })
    .click({ timeout: 15000 });

  await page.waitForTimeout(3000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  let rate = null;

  const patterns = [
    /GBP\s*[≈=]\s*([0-9.]+)\s*GHS/i,
    /1\s*GBP\s*[≈=]\s*([0-9.]+)\s*GHS/i,
    /\b(1[0-9]\.\d{2,5})\b/,
  ];

  for (const regex of patterns) {
    const match = bodyText.match(regex);
    if (!match) continue;

    const candidate = parseLocaleNumber(match[1] || match[0]);
    if (candidate && candidate >= 10 && candidate <= 25) {
      rate = Number(candidate.toFixed(6));
      break;
    }
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract Nala rate.${file ? ` Screenshot: ${file}` : ""}`);
  }

  return buildResult(source, rate, 0, rate);
}

async function handleRozeRemit(page, source) {
  await page.goto("https://rozeremit.com/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(4000);

  await page.getByRole("img").nth(1).click().catch(() => {});
  await page.waitForTimeout(1000);

  const searchBox = page.getByRole("textbox", { name: "Type here to search..." });
  await searchBox.waitFor({ timeout: 10000 });
  await searchBox.click();
  await searchBox.fill("un");
  await page.waitForTimeout(1200);
  await page.locator("#modal").getByText("United Kingdom").click();

  await page.waitForTimeout(1000);

  await page.getByRole("button", { name: "Later" }).click({ timeout: 3000 }).catch(() => {});
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(1000);

  await page
    .locator("div")
    .filter({ hasText: /^Send money toChoose Country$/ })
    .first()
    .click({ force: true });

  const countrySearch = page.getByRole("textbox", { name: "Type here to search..." });
  await countrySearch.click();
  await countrySearch.fill("gh");
  await page.waitForTimeout(1200);
  await page.getByText("Ghana", { exact: true }).click();

  await page.waitForTimeout(1500);

  await page.goto("https://rozeremit.com/ghana/send-money-to-ghana?sending=GB", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(5000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  let payload = buildPayloadFromText(source, bodyText);

  if (!payload) {
    let rate = null;

    const ratePatterns = [
      /\b15\.\d{2,4}\b/,
      /GBP\s*1\s*=\s*([0-9.]+)\s*GHS/i,
      /1\s*GBP\s*=\s*([0-9.]+)\s*GHS/i,
    ];

    for (const regex of ratePatterns) {
      const match = bodyText.match(regex);
      if (!match) continue;
      rate = parseFloat(match[1] || match[0]);
      if (!Number.isNaN(rate)) break;
    }

    if (rate) {
      payload = {
        provider_name: source.provider,
        origin_country: source.origin,
        destination_country: source.destination,
        payout_method: source.payout_method,
        send_amount: Number(source.send_amount || 1),
        exchange_rate: rate,
        fee: 0,
        amount_received: Number((rate * Number(source.send_amount || 1)).toFixed(3)),
        delivery_speed: null,
        source_type: "browser_automation",
        verification_status: "verified_from_quote_page",
        source_url: source.url,
        checked_at: new Date().toISOString(),
      };
    }
  }

  if (!payload) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract Roze Remit rate. Screenshot: ${file}`);
  }

  return payload;
}

async function handleUnityLink(page, source) {
  await page.goto("https://www.unitylink.com/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(5000);

  await page.getByRole("button", { name: "🇬🇧 United Kingdom" }).click().catch(() => {});
  await page.waitForTimeout(1000);

  await page.getByRole("button", { name: /GB GBP/i }).click().catch(() => {});
  await page.waitForTimeout(1000);

  await page.getByRole("button", { name: /GB United Kingdom GBP/i }).click().catch(() => {});
  await page.waitForTimeout(1000);

  await page.getByRole("button", { name: /GH GHS/i }).click().catch(() => {});
  await page.waitForTimeout(1000);

  await page.getByRole("button", { name: /GH Ghanaian Cedi GHS/i }).click().catch(() => {});
  await page.waitForTimeout(1500);

  const visibleInputs = page.locator("input:visible");
  const count = await visibleInputs.count();
  if (!count) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`UnityLink amount input not found. Screenshot: ${file}`);
  }

  const sendInput = visibleInputs.nth(0);
  await sendInput.click({ force: true });
  await sendInput.press("Control+A").catch(() => {});
  await sendInput.fill("1");

  await page.waitForTimeout(5000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  let payload = buildPayloadFromText(source, bodyText);

  if (!payload) {
    let rate = null;

    const patterns = [
      /1\s*GBP\s*=\s*([0-9.]+)\s*GHS/i,
      /GBP\s*1\s*=\s*([0-9.]+)\s*GHS/i,
      /\b14\.\d{2,4}\b/,
    ];

    for (const regex of patterns) {
      const match = bodyText.match(regex);
      if (!match) continue;
      rate = parseFloat(match[1] || match[0]);
      if (!Number.isNaN(rate)) break;
    }

    if (rate) {
      payload = {
        provider_name: source.provider,
        origin_country: source.origin,
        destination_country: source.destination,
        payout_method: source.payout_method,
        send_amount: Number(source.send_amount || 1),
        exchange_rate: rate,
        fee: 0,
        amount_received: Number((rate * Number(source.send_amount || 1)).toFixed(3)),
        delivery_speed: null,
        source_type: "browser_automation",
        verification_status: "verified_from_quote_page",
        source_url: source.url,
        checked_at: new Date().toISOString(),
      };
    }
  }

  if (!payload) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract UnityLink rate. Screenshot: ${file}`);
  }

  return payload;
}

async function handleAfripay(page, source) {
  await page.goto("https://afripay.uk/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(4000);

  await page.locator("#ddlcountry").selectOption("104");
  await page.waitForTimeout(1000);

  await page
    .getByRole("link", { name: /Proceed with Sending Payment/i })
    .click();

  await page.waitForTimeout(3000);

  const amountInput = page.locator("#txtAmount");
  await amountInput.waitFor({ timeout: 10000 });
  await amountInput.click();
  await amountInput.fill("1");

  await page.waitForTimeout(5000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  let payload = buildPayloadFromText(source, bodyText);

  if (!payload) {
    let rate = null;

    const patterns = [
      /Exchange Rate[^0-9]*1\s*GBP\s*=\s*([0-9.]+)\s*GHS/i,
      /1\s*GBP\s*=\s*([0-9.]+)\s*GHS/i,
      /\b(1[0-9]\.\d{2,4})\b/,
    ];

    for (const regex of patterns) {
      const match = bodyText.match(regex);
      if (!match) continue;
      rate = parseFloat(match[1] || match[0]);
      if (!Number.isNaN(rate) && rate > 0) break;
    }

    if (rate) {
      payload = {
        provider_name: source.provider,
        origin_country: source.origin,
        destination_country: source.destination,
        payout_method: source.payout_method,
        send_amount: 1,
        exchange_rate: rate,
        fee: 0,
        amount_received: Number(rate.toFixed(3)),
        delivery_speed: null,
        source_type: "browser_automation",
        verification_status: "verified_from_quote_page",
        source_url: source.url,
        checked_at: new Date().toISOString(),
      };
    }
  }

  if (!payload) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract Afripay rate. Screenshot: ${file}`);
  }

  return payload;
}

async function handleContinentalMoney(page, source) {
  await page.goto("https://www.continental.money/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(5000);

  // Sending currency = GBP
  await page.getByText("GBP GBP").click({ timeout: 5000 }).catch(() => {});
  await page.getByRole("option", { name: "GBP GBP" }).click({ timeout: 5000 }).catch(() => {});

  await page.waitForTimeout(1000);

  // Receiving currency = GHS
  await page.getByText("GHS").nth(2).click({ timeout: 5000 }).catch(async () => {
    await page.getByText("GHS GHS").click({ timeout: 5000 }).catch(() => {});
  });
  await page.getByRole("option", { name: "GHS GHS" }).click({ timeout: 5000 }).catch(() => {});

  await page.waitForTimeout(1000);

  const sendInput = page.getByRole("spinbutton", { name: /I'm sending/i });
  await sendInput.waitFor({ timeout: 10000 });
  await sendInput.click({ force: true });
  await sendInput.press("Control+A").catch(() => {});
  await sendInput.fill("100");

  await page.waitForTimeout(5000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  let rate = null;

  // First try explicit rate patterns
  const explicitPatterns = [
    /1\s*GBP\s*=\s*([0-9.]+)\s*GHS/i,
    /GBP\s*1\s*=\s*([0-9.]+)\s*GHS/i,
    /([0-9]+(?:\.[0-9]+)?)\s*GHS/i,
  ];

  for (const regex of explicitPatterns) {
    const match = bodyText.match(regex);
    if (!match) continue;

    const candidate = parseLocaleNumber(match[1]);
    if (candidate && candidate >= 10 && candidate <= 20) {
      rate = candidate;
      break;
    }
  }

  // Loose fallback only if explicit extraction failed
  if (!rate) {
    const looseMatches = bodyText.match(/\b1[0-9]\.\d{1,5}\b/g) || [];
    const candidates = looseMatches
      .map((v) => parseFloat(v))
      .filter((v) => !Number.isNaN(v) && v >= 10 && v <= 20);

    if (candidates.length) {
      rate = candidates[0];
    }
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract Continental Money rate. Screenshot: ${file}`);
  }

  return buildResult(source, rate, 0, rate, {
    quoted_send_amount: 100,
  });
}

async function handleFPTransfer(page, source) {
  await page.goto("https://fastpacetransfer.com/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(4000);

  await page.getByRole("link", { name: /Remittances/i }).click().catch(() => {});
  await page.waitForTimeout(2000);

  await page.locator("#top").getByRole("combobox").selectOption("uk").catch(() => {});
  await page.goto("https://fastpacetransfer.com/remittances/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(4000);

  const sendInput = page.getByRole("spinbutton", { name: /You Send/i });
  await sendInput.waitFor({ timeout: 10000 });
  await sendInput.click({ force: true });
  await sendInput.press("Control+A").catch(() => {});
  await sendInput.fill("100");

  await page.waitForTimeout(5000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  let rate = null;
  const patterns = [
    /Exchange Rate:\s*1\s*GBP\s*=\s*([0-9.]+)/i,
    /1\s*GBP\s*=\s*([0-9.]+)\s*GHS/i,
    /\b(1[0-9]\.\d{1,5})\b/,
  ];

  for (const regex of patterns) {
    const match = bodyText.match(regex);
    if (!match) continue;
    const candidate = parseLocaleNumber(match[1] || match[0]);
    if (candidate && candidate >= 10 && candidate <= 20) {
      rate = candidate;
      break;
    }
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract FP Transfer rate. Screenshot: ${file}`);
  }

  return buildResult(source, rate, 0, rate, {
    quoted_send_amount: 100,
  });
}

async function handleInstarem(page, source) {
  await page.goto("https://www.instarem.com/en-gb/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(5000);

  await page
    .locator(".widget-calculator__dropdown-main-right")
    .first()
    .click();

  const searchBox1 = page.getByRole("textbox", {
    name: /Search country or currency/i,
  });
  await searchBox1.waitFor({ timeout: 10000 });
  await searchBox1.fill("gb");
  await page.getByText("United Kingdom").nth(1).click();

  await page.waitForTimeout(1500);

  await page
    .locator(".widget-calculator__recive > .widget-calculator__dropdown > .widget-calculator__dropdown-main > .widget-calculator__dropdown-main-right")
    .click();

  const searchBox2 = page.getByRole("textbox", {
    name: /Search country or currency/i,
  });
  await searchBox2.fill("gh");
  await page.getByText("Ghana GHS").click();

  await page.waitForTimeout(1500);

  const sendInput = page.getByRole("textbox", { name: /You send/i });
  await sendInput.click();
  await sendInput.fill("1");

  await page.waitForTimeout(6000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  let payload = buildPayloadFromText(source, bodyText);

  if (!payload) {
    let rate = null;

    const patterns = [
      /1\s*GBP\s*=\s*([0-9.]+)\s*GHS/i,
      /([0-9.]+)\s*GHS/i,
      /\b(1[0-9]\.\d{2,4})\b/,
    ];

    for (const regex of patterns) {
      const match = bodyText.match(regex);
      if (!match) continue;
      rate = parseFloat(match[1] || match[0]);
      if (!Number.isNaN(rate) && rate > 0) break;
    }

    if (rate) {
      payload = {
        provider_name: source.provider,
        origin_country: source.origin,
        destination_country: source.destination,
        payout_method: source.payout_method,
        send_amount: 1,
        exchange_rate: rate,
        fee: 0,
        amount_received: Number(rate.toFixed(3)),
        delivery_speed: null,
        source_type: "browser_automation",
        verification_status: "verified_from_quote_page",
        source_url: source.url,
        checked_at: new Date().toISOString(),
      };
    }
  }

  if (!payload) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract Instarem rate. Screenshot: ${file}`);
  }

  return payload;
}

async function handleJupay(page, source) {
  await page.goto("https://jupay.co/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(5000);

  await page.locator("#country").first().selectOption("GBP");
  await page.waitForTimeout(1500);

  const scrapeAmount = 100;

  const sendInput = page.getByRole("textbox", { name: /You send/i });
  await sendInput.waitFor({ timeout: 10000 });
  await sendInput.click();
  await sendInput.fill(String(scrapeAmount));

  await page
    .locator("div")
    .filter({ hasText: /Simple Fast Money Transfer/i })
    .nth(2)
    .click()
    .catch(() => {});
  await page.keyboard.press("Tab").catch(() => {});

  await page.waitForTimeout(6000);

  const receiveInput = page.getByRole("textbox", { name: /Recipient gets/i });

  let amountReceivedTotal = null;
  if (await receiveInput.count()) {
    const rawReceive = await receiveInput.inputValue().catch(() => "");
    const parsed = parseLocaleNumber(rawReceive);
    if (parsed && parsed > 0) amountReceivedTotal = parsed;
  }

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  let rate = null;

  if (amountReceivedTotal && scrapeAmount > 0) {
    rate = Number((amountReceivedTotal / scrapeAmount).toFixed(6));
  }

  if (!rate) {
    const patterns = [
      /Exchange Rate:\s*([0-9.]+)\s*Fees:/i,
      /1\s*GBP\s*=\s*([0-9.]+)\s*GHS/i,
      /GBP\s*=\s*([0-9.]+)\s*GHS/i,
      /\b(1[0-9]\.\d{2,5})\b/,
    ];

    for (const regex of patterns) {
      const match = bodyText.match(regex);
      if (!match) continue;
      const candidate = parseLocaleNumber(match[1] || match[0]);
      if (candidate && candidate > 0) {
        rate = Number(candidate.toFixed(6));
        break;
      }
    }
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract Jupay rate. Screenshot: ${file}`);
  }

  return {
    provider_name: source.provider,
    origin_country: source.origin,
    destination_country: source.destination,
    payout_method: source.payout_method,
    send_amount: 1,
    exchange_rate: rate,
    amount_received: Number(rate.toFixed(6)),
    fee: 0,
    delivery_speed: null,
    source_type: "browser_automation",
    verification_status: "verified_from_quote_page",
    source_url: source.url,
    checked_at: new Date().toISOString(),
    quoted_send_amount: scrapeAmount,
    quoted_amount_received: amountReceivedTotal,
  };
}

async function handleOaPay(page, source) {
  await page.goto("https://www.oapay.co/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(5000);

  await page.getByText("GBP").nth(1).click().catch(() => {});
  await page.getByText("GBP United Kingdom").click().catch(() => {});

  await page.waitForTimeout(1200);

  await page.getByText("GHS").nth(2).click().catch(() => {});
  await page.getByText("GHS Ghana").click().catch(() => {});

  await page.waitForTimeout(1500);

  const sendOrReceiveBox = page.getByRole("textbox", { name: /Recipient Receives/i });
  await sendOrReceiveBox.waitFor({ timeout: 10000 });
  await sendOrReceiveBox.click();
  await sendOrReceiveBox.fill("1");

  await page.waitForTimeout(5000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  let rate = null;

  const patterns = [
    /GBP\s*=\s*([0-9.]+)\s*GHS\s*\(no charges\)/i,
    /1\.00\s*GBP\s*=\s*([0-9.]+)\s*GHS/i,
    /1\s*GBP\s*=\s*([0-9.]+)\s*GHS/i,
    /\b(1[0-9]\.\d{2,5})\b/,
  ];

  for (const regex of patterns) {
    const match = bodyText.match(regex);
    if (!match) continue;
    const candidate = parseLocaleNumber(match[1] || match[0]);
    if (candidate && candidate > 0) {
      rate = Number(candidate.toFixed(6));
      break;
    }
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract OaPay rate. Screenshot: ${file}`);
  }

  return {
    provider_name: source.provider,
    origin_country: source.origin,
    destination_country: source.destination,
    payout_method: source.payout_method,
    send_amount: 1,
    exchange_rate: rate,
    amount_received: Number(rate.toFixed(6)),
    fee: 0,
    delivery_speed: null,
    source_type: "browser_automation",
    verification_status: "verified_from_quote_page",
    source_url: source.url,
    checked_at: new Date().toISOString(),
  };
}

async function handleOhentPay(page, source) {
  await page.goto("https://www.ohentpay.com/en-GB", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(5000);

  await page.getByRole("link", { name: /flag Ghana/i }).click().catch(() => {});
  await page.waitForTimeout(2000);

  await page
    .getByRole("combobox")
    .filter({ hasText: /GBP|Select currency/i })
    .first()
    .click()
    .catch(() => {});
  await page.getByText("Great British Pounds (GBP)").click().catch(() => {});

  await page.waitForTimeout(1500);

  const amountInput = page.getByRole("textbox", { name: "0.00" }).first();
  await amountInput.waitFor({ timeout: 10000 });
  await amountInput.click();
  await amountInput.fill("1");

  await page.getByText(/You send|Exchange rate/i).click().catch(() => {});
  await page.keyboard.press("Tab").catch(() => {});

  await page.waitForTimeout(5000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  let rate = null;

  const patterns = [
    /GBP\s*=\s*([0-9.]+)\s*GHS/i,
    /Exchange rate\s*1\s*GBP\s*=\s*([0-9.]+)\s*GHS/i,
    /1\s*GBP\s*=\s*([0-9.]+)\s*GHS/i,
    /\b(1[0-9]\.\d{2,5})\b/,
  ];

  for (const regex of patterns) {
    const match = bodyText.match(regex);
    if (!match) continue;
    const candidate = parseLocaleNumber(match[1] || match[0]);
    if (candidate && candidate > 0) {
      rate = Number(candidate.toFixed(6));
      break;
    }
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract Ohent Pay rate. Screenshot: ${file}`);
  }

  return {
    provider_name: source.provider,
    origin_country: source.origin,
    destination_country: source.destination,
    payout_method: source.payout_method,
    send_amount: 1,
    exchange_rate: rate,
    amount_received: Number(rate.toFixed(6)),
    fee: 0,
    delivery_speed: null,
    source_type: "browser_automation",
    verification_status: "verified_from_quote_page",
    source_url: source.url,
    checked_at: new Date().toISOString(),
  };
}

async function handlePadiePay(page, source) {
  await page.goto("https://www.padiepay.com/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(5000);

  await page.getByRole("button", { name: /Maybe, later/i }).click({ timeout: 5000 }).catch(() => {});

  await page.getByRole("button", { name: /🇨🇦 CAD|CAD/i }).click().catch(() => {});
  await page.getByText("British Pound Sterling").click().catch(() => {});
  await page.waitForTimeout(1500);

  await page.getByRole("button", { name: /🇳🇬 NGN|NGN/i }).click().catch(() => {});
  await page.getByText("🇬🇭GHSGhanaian Cedi").click().catch(async () => {
    await page.getByText(/Ghanaian Cedi/i).click().catch(() => {});
  });

  await page.waitForTimeout(2000);

  const visibleInputs = page.locator("input:visible");
  const inputCount = await visibleInputs.count();

  if (!inputCount) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`PadiePay amount input not found. Screenshot: ${file}`);
  }

  let amountFilled = false;
  for (let i = 0; i < inputCount; i++) {
    const input = visibleInputs.nth(i);
    try {
      await input.click({ force: true });
      await input.press("Control+A").catch(() => {});
      await input.fill("1");
      const val = await input.inputValue().catch(() => "");
      if (String(val).trim() === "1") {
        amountFilled = true;
        break;
      }
    } catch (_) {}
  }

  if (!amountFilled) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not fill PadiePay amount input. Screenshot: ${file}`);
  }

  await page.getByText(/GBP =|Transfer fee|Exchange|Free/i).click().catch(() => {});
  await page.keyboard.press("Tab").catch(() => {});
  await page.waitForTimeout(5000);

  let directRateText = "";
  const rateLocator = page.getByText(/GBP\s*=\s*[\d.]+\s*GHS/i).first();
  if (await rateLocator.count()) {
    directRateText = (await rateLocator.innerText().catch(() => "")) || "";
  }

  const bodyText = await page.locator("body").innerText();
  const combinedText = `${directRateText}\n${bodyText}`;
  saveDebugText(source.provider, combinedText);

  let rate = null;

  const patterns = [
    /GBP\s*=\s*([0-9.]+)\s*GHS/i,
    /1\s*GBP\s*=\s*([0-9.]+)\s*GHS/i,
    /Exchange[^0-9]*([0-9.]+)\s*GHS/i,
  ];

  for (const regex of patterns) {
    const match = combinedText.match(regex);
    if (!match) continue;
    const candidate = parseLocaleNumber(match[1]);
    if (candidate && candidate > 0 && candidate < 100) {
      rate = Number(candidate.toFixed(6));
      break;
    }
  }

  if (!rate) {
    const looseMatches = combinedText.match(/\b1[0-9]\.\d{2,5}\b/g) || [];
    const candidates = looseMatches
      .map((v) => parseFloat(v))
      .filter((v) => !Number.isNaN(v) && v >= 10 && v <= 20);

    if (candidates.length) {
      rate = Number(candidates[0].toFixed(6));
    }
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract PadiePay rate. Screenshot: ${file}`);
  }

  return {
    provider_name: source.provider,
    origin_country: source.origin,
    destination_country: source.destination,
    payout_method: source.payout_method,
    send_amount: 1,
    exchange_rate: rate,
    amount_received: Number(rate.toFixed(6)),
    fee: 0,
    delivery_speed: null,
    source_type: "browser_automation",
    verification_status: "verified_from_quote_page",
    source_url: source.url,
    checked_at: new Date().toISOString(),
  };
}

async function handlePaysend(page, source) {
  await page.goto("https://paysend.com/en-gb", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(5000);

  await page.getByRole("button", { name: /Accept All Cookies/i }).click({ timeout: 6000 }).catch(() => {});

  await page.locator("a").filter({ hasText: /^GBP$/ }).click({ timeout: 8000 }).catch(() => {});
  let searchBox = page.getByPlaceholder("Search for a country");
  await searchBox.waitFor({ timeout: 10000 });
  await searchBox.fill("gb");
  await page.waitForTimeout(1000);
  await page.getByText(/United KingdomGBP/i).click().catch(() => {});

  await page.waitForTimeout(1500);

  await page.locator("a").filter({ hasText: /^[A-Z]{3}$/ }).nth(1).click().catch(() => {});
  searchBox = page.getByPlaceholder("Search for a country");
  await searchBox.fill("gh");
  await page.waitForTimeout(1000);

  await page.getByText(/GhanaGHSUSD/i).click().catch(() => {});
  await page.getByText(/Ghana CediGHS/i).click().catch(() => {});

  await page.waitForTimeout(2500);

  for (let i = 0; i < 3; i++) {
    await page.locator("a").filter({ hasText: /^OK$/ }).click({ timeout: 2500 }).catch(() => {});
    await page.waitForTimeout(800);
  }

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  let rate = null;
  const patterns = [
    /Today[’']s rate:\s*1\.00\s*GBP\s*=\s*([0-9.]+)/i,
    /1\.00\s*GBP\s*=\s*([0-9.]+)\s*GHS/i,
    /1\s*GBP\s*=\s*([0-9.]+)\s*GHS/i,
    /\b(1[0-9]\.\d{2,5})\b/,
  ];

  for (const regex of patterns) {
    const match = bodyText.match(regex);
    if (!match) continue;
    const candidate = parseLocaleNumber(match[1] || match[0]);
    if (candidate && candidate >= 10 && candidate <= 20) {
      rate = candidate;
      break;
    }
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract Paysend rate. Screenshot: ${file}`);
  }

  return buildResult(source, rate, 0, rate);
}

async function handlePesaCo(page, source) {
  await page.goto("https://www.pesa.co/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(5000);

  await page.locator("#send-option").getByText("CAD").click().catch(() => {});
  await page.getByText("GBP").first().click().catch(() => {});

  await page.waitForTimeout(1200);

  await page.locator("#receive-option").getByText("NGN").click().catch(() => {});
  await page.getByText("GHS").nth(1).click().catch(async () => {
    await page.getByText(/^GHS$/).click().catch(() => {});
  });

  await page.waitForTimeout(1500);

  const scrapeAmount = 100;

  const sendInput = page.locator("#sendAmount");
  await sendInput.waitFor({ timeout: 10000 });
  await sendInput.click({ force: true });
  await sendInput.press("Control+A").catch(() => {});
  await sendInput.fill(String(scrapeAmount));

  await page.locator(".div-block-71 > div:nth-child(3)").click().catch(() => {});
  await page.keyboard.press("Tab").catch(() => {});

  await page.waitForTimeout(5000);

  let directRateText = "";
  const rateLocator = page.locator("#rateValue");
  if (await rateLocator.count()) {
    directRateText = (await rateLocator.innerText().catch(() => "")) || "";
  }

  const bodyText = await page.locator("body").innerText();
  const combinedText = `${directRateText}\n${bodyText}`;
  saveDebugText(source.provider, combinedText);

  let rate = null;

  const patterns = [
    /1\s*GBP\s*=\s*([0-9.]+)\s*GHS/i,
    /By exchange rate\s*1\s*GBP\s*=\s*([0-9.]+)\s*GHS/i,
    /exchange rate\s*1\s*GBP\s*=\s*([0-9.]+)\s*GHS/i,
    /\b(1[0-9]\.\d{2,5})\b/,
  ];

  for (const regex of patterns) {
    const match = combinedText.match(regex);
    if (!match) continue;
    const candidate = parseLocaleNumber(match[1] || match[0]);
    if (candidate && candidate > 0 && candidate < 100) {
      rate = Number(candidate.toFixed(6));
      break;
    }
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract Pesa.co rate. Screenshot: ${file}`);
  }

  return {
    provider_name: source.provider,
    origin_country: source.origin,
    destination_country: source.destination,
    payout_method: source.payout_method,
    send_amount: 1,
    exchange_rate: rate,
    amount_received: Number(rate.toFixed(6)),
    fee: 0,
    delivery_speed: null,
    source_type: "browser_automation",
    verification_status: "verified_from_quote_page",
    source_url: source.url,
    checked_at: new Date().toISOString(),
    quoted_send_amount: scrapeAmount,
  };
}

async function handleRemitnGo(page, source) {
  await page.goto("https://remitngo.com/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(5000);

  await page.getByRole("img").nth(1).click().catch(() => {});
  await page.waitForTimeout(1200);

  await page.locator("div").filter({ hasText: /^Ghana$/ }).first().click().catch(async () => {
    await page.getByText(/^Ghana$/).click().catch(() => {});
  });

  await page.waitForTimeout(2000);

  const scrapeAmount = 100;

  const sendInput = page.locator("#src-send-amount").first();
  await sendInput.waitFor({ timeout: 10000 });
  await sendInput.click({ force: true });
  await sendInput.press("Control+A").catch(() => {});
  await sendInput.fill(String(scrapeAmount));

  await page.keyboard.press("Tab").catch(() => {});
  await page.waitForTimeout(5000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  let rate = null;
  let amountReceivedTotal = null;

  const ratePatterns = [
    /1\s*GBP\s*=\s*([0-9.]+)\s*GHS/i,
    /GBP\s*1\s*=\s*([0-9.]+)\s*GHS/i,
    /\b(1[0-9]\.\d{2,5})\b/,
  ];

  for (const regex of ratePatterns) {
    const match = bodyText.match(regex);
    if (!match) continue;
    const candidate = parseLocaleNumber(match[1] || match[0]);
    if (candidate && candidate > 0 && candidate < 100) {
      rate = Number(candidate.toFixed(6));
      break;
    }
  }

  if (!rate) {
    const receivePatterns = [
      /Recipient gets[^0-9]*([0-9,.]+)\s*GHS/i,
      /They receive[^0-9]*([0-9,.]+)\s*GHS/i,
      /You receive[^0-9]*([0-9,.]+)\s*GHS/i,
    ];

    for (const regex of receivePatterns) {
      const match = bodyText.match(regex);
      if (!match) continue;
      const candidate = parseLocaleNumber(match[1]);
      if (candidate && candidate > 0) {
        amountReceivedTotal = candidate;
        break;
      }
    }

    if (amountReceivedTotal && scrapeAmount > 0) {
      rate = Number((amountReceivedTotal / scrapeAmount).toFixed(6));
    }
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract RemitnGo rate. Screenshot: ${file}`);
  }

  return {
    provider_name: source.provider,
    origin_country: source.origin,
    destination_country: source.destination,
    payout_method: source.payout_method,
    send_amount: 1,
    exchange_rate: rate,
    amount_received: Number(rate.toFixed(6)),
    fee: 0,
    delivery_speed: null,
    source_type: "browser_automation",
    verification_status: "verified_from_quote_page",
    source_url: source.url,
    checked_at: new Date().toISOString(),
    quoted_send_amount: scrapeAmount,
    quoted_amount_received: amountReceivedTotal,
  };
}

async function handleSendBuddie(page, source) {
  await page.goto("https://www.sendbuddie.com/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(5000);

  await page.getByRole("combobox").filter({ hasText: "GBP" }).click().catch(() => {});
  let searchBox = page.getByPlaceholder("Search...");
  await searchBox.waitFor({ timeout: 10000 });
  await searchBox.fill("G");
  await page.waitForTimeout(1000);
  await page.getByRole("option", { name: "GBP GBP" }).click().catch(async () => {
    await page.getByText(/GBP GBP/i).click().catch(() => {});
  });

  await page.waitForTimeout(1500);

  await page.getByRole("combobox").filter({ hasText: "NIGERIA" }).click().catch(async () => {
    const comboboxes = page.getByRole("combobox");
    const count = await comboboxes.count();
    if (count >= 2) {
      await comboboxes.nth(1).click().catch(() => {});
    }
  });

  searchBox = page.getByPlaceholder("Search...");
  await searchBox.click();
  await searchBox.fill("GH");
  await page.waitForTimeout(1000);

  await page.getByRole("option", { name: "GH GHANA" }).click().catch(async () => {
    await page.getByText(/GH GHANA/i).click().catch(() => {});
  });

  await page.waitForTimeout(4000);

  let directRateText = "";
  const rateLocator = page.getByText(/1\s*GBP\s*=\s*[\d.]+\s*GHS/i).first();
  if (await rateLocator.count()) {
    directRateText = (await rateLocator.innerText().catch(() => "")) || "";
  }

  const bodyText = await page.locator("body").innerText();
  const combinedText = `${directRateText}\n${bodyText}`;
  saveDebugText(source.provider, combinedText);

  let rate = null;

  const patterns = [
    /1\s*GBP\s*=\s*([0-9.]+)\s*GHS/i,
    /GBP\s*=\s*([0-9.]+)\s*GHS/i,
    /\b(1[0-9]\.\d{2,5})\b/,
  ];

  for (const regex of patterns) {
    const match = combinedText.match(regex);
    if (!match) continue;
    const candidate = parseLocaleNumber(match[1] || match[0]);
    if (candidate && candidate > 0 && candidate < 100) {
      rate = Number(candidate.toFixed(6));
      break;
    }
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract SendBuddie rate. Screenshot: ${file}`);
  }

  return {
    provider_name: source.provider,
    origin_country: source.origin,
    destination_country: source.destination,
    payout_method: source.payout_method,
    send_amount: 1,
    exchange_rate: rate,
    amount_received: Number(rate.toFixed(6)),
    fee: 0,
    delivery_speed: null,
    source_type: "browser_automation",
    verification_status: "verified_from_quote_page",
    source_url: source.url,
    checked_at: new Date().toISOString(),
  };
}

async function handleTransferGalaxy(page, source) {
  await page.goto("https://transfergalaxy.com/en/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(5000);

  // Language
  await page.locator("#languageModal a").filter({ hasText: "English" }).click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(1200);

  // Cookies
  await page.getByRole("button", { name: /Allow all/i }).click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(1200);

  // Sending country = United Kingdom
  await page.getByRole("combobox", { name: /Sweden|United Kingdom/i }).click().catch(() => {});
  await page.waitForTimeout(1000);

  await page.locator("#bs-select-1-3").click().catch(async () => {
    await page.getByText(/United Kingdom/i).first().click().catch(() => {});
  });

  await page.waitForTimeout(1200);

  // Receiving country = Ghana
  await page.getByRole("combobox", { name: /Pick a country/i }).click().catch(() => {});
  await page.waitForTimeout(800);

  await page.getByRole("combobox", { name: "Search" }).fill("gh").catch(() => {});
  await page.waitForTimeout(1200);

  await page.locator("#bs-select-2-28").click().catch(async () => {
    await page.getByText(/^Ghana$/).click().catch(() => {});
  });

  await page.waitForTimeout(4000);

  // Read direct rate text from the exact widget first
  let widgetText = "";
  const aocLocator = page.locator("#aocResponse");
  if (await aocLocator.count()) {
    widgetText = (await aocLocator.innerText().catch(() => "")) || "";
  }

  const bodyText = await page.locator("body").innerText();
  const combinedText = `${widgetText}\n${bodyText}`;
  saveDebugText(source.provider, combinedText);

  let rate = null;

  // Strong direct patterns first
  const primaryPatterns = [
    /GBP\s*=\s*([0-9.]+)\s*GHS/i,
    /1\s*GBP\s*=\s*([0-9.]+)\s*GHS/i,
    /exchange rate[^0-9]*([0-9.]+)\s*GHS/i,
  ];

  for (const regex of primaryPatterns) {
    const match = combinedText.match(regex);
    if (!match) continue;

    const candidate = parseLocaleNumber(match[1]);
    if (candidate && candidate >= 10 && candidate <= 20) {
      rate = candidate;
      break;
    }
  }

  // Controlled fallback only within realistic corridor range
  if (!rate) {
    const looseMatches = combinedText.match(/\b1[0-9]\.\d{2,5}\b/g) || [];
    const candidates = looseMatches
      .map((v) => parseFloat(v))
      .filter((v) => !Number.isNaN(v) && v >= 10 && v <= 20);

    if (candidates.length) {
      rate = candidates[0];
    }
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract TransferGalaxy rate. Screenshot: ${file}`);
  }

  return buildResult(source, rate, 0, rate);
}

async function handleVeloRemit(page, source) {
  await page.goto("https://veloremit.com/en", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(5000);

  await page.locator("#mantine-yrg5ki2en-target").getByText("English").click({ timeout: 5000 }).catch(() => {});
  await page.getByRole("link", { name: "English" }).click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(1500);

  await page.getByRole("button", { name: /Currency Converter/i }).click({ timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(3000);

  let directRateText = "";
  const rateLocator = page.getByText(/GBP\s*[≈=]\s*[\d.]+\s*GHS/i).first();
  if (await rateLocator.count()) {
    directRateText = (await rateLocator.innerText().catch(() => "")) || "";
  }

  const bodyText = await page.locator("body").innerText();
  const combinedText = `${directRateText}\n${bodyText}`;
  saveDebugText(source.provider, combinedText);

  let rate = null;

  const patterns = [
    /GBP\s*[≈=]\s*([0-9.]+)\s*GHS/i,
    /1\s*GBP\s*[≈=]\s*([0-9.]+)\s*GHS/i,
    /\b(1[0-9]\.\d{1,5})\b/,
  ];

  for (const regex of patterns) {
    const match = combinedText.match(regex);
    if (!match) continue;
    const candidate = parseLocaleNumber(match[1] || match[0]);
    if (candidate && candidate > 0 && candidate < 100) {
      rate = Number(candidate.toFixed(6));
      break;
    }
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract VeloRemit rate. Screenshot: ${file}`);
  }

  return {
    provider_name: source.provider,
    origin_country: source.origin,
    destination_country: source.destination,
    payout_method: source.payout_method,
    send_amount: 1,
    exchange_rate: rate,
    amount_received: Number(rate.toFixed(6)),
    fee: 0,
    delivery_speed: null,
    source_type: "browser_automation",
    verification_status: "verified_from_quote_page",
    source_url: source.url,
    checked_at: new Date().toISOString(),
  };
}

async function handleJubaExpress(page, source) {
  await page.goto("https://www.jubaexpress.com/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(5000);

  const sendingSelect = page.locator("ng-select").filter({ hasText: /Select a sending country/i });
  await sendingSelect.getByRole("textbox").click();
  await page.waitForTimeout(1000);
  await page.getByRole("option", { name: /UNITED KINGDOM/i }).click();

  await page.waitForTimeout(1200);

  const destinationSelect = page.locator("ng-select").filter({ hasText: /Select destination country/i });
  await destinationSelect.getByRole("textbox").click();
  await destinationSelect.getByRole("textbox").fill("gh");
  await page.waitForTimeout(1200);
  await page.getByRole("option", { name: /GHANA/i }).click();

  await page.waitForTimeout(1000);

  await page.getByRole("button", { name: /CONTINUE/i }).click();
  await page.waitForTimeout(5000);

  const paymentSelect = page.locator("ng-select").filter({ hasText: /Select Payment Mode/i });
  await paymentSelect.getByRole("textbox").click();
  await page.waitForTimeout(1000);
  await page.getByText(/MTN Mobile Money/i).click();

  await page.waitForTimeout(2500);

  const sendInput = page.getByRole("textbox", { name: /You Send/i });
  await sendInput.waitFor({ timeout: 15000 });
  await sendInput.click({ force: true });
  await sendInput.press("Control+A").catch(() => {});
  await sendInput.fill("100");

  await page.locator("div").filter({ hasText: /ReviewTransaction/i }).nth(2).click().catch(() => {});
  await page.waitForTimeout(6000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  let rate = null;
  const patterns = [
    /Exchange Rate[^0-9]*1\s*GBP\s*=\s*([0-9.]+)/i,
    /1\s*GBP\s*=\s*([0-9.]+)\s*GHS/i,
    /\b(1[0-9]\.\d{2,5})\b/,
  ];

  for (const regex of patterns) {
    const match = bodyText.match(regex);
    if (!match) continue;
    const candidate = parseLocaleNumber(match[1] || match[0]);
    if (candidate && candidate >= 10 && candidate <= 20) {
      rate = candidate;
      break;
    }
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract JubaExpress rate. Screenshot: ${file}`);
  }

  return buildResult(source, rate, 0, rate, {
    quoted_send_amount: 100,
  });
}

async function handleMukuru(page, source) {
  await page.goto("https://www.mukuru.com/en-uk/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(6000);

  const frame = page.locator('iframe[name="calculatorFrame"]').contentFrame();

  await frame.locator("#to_country").selectOption("GH");
  await page.waitForTimeout(1500);

  await frame.getByText(/Payment method Debit \/ Credit/i).click({
    timeout: 15000,
  }).catch(() => {});

  const payInput = frame.getByRole("spinbutton", { name: /You pay/i });
  await payInput.waitFor({ timeout: 20000 });
  await payInput.click({ force: true });
  await payInput.press("Control+A").catch(() => {});
  await payInput.fill("100");

  await page.waitForTimeout(1000);

  await frame.getByRole("button", { name: /Calculate/i }).click({
    timeout: 15000,
  });

  await page.waitForTimeout(4000);

  let rateText = "";
  const rateLocator = frame.locator("#rate_message_container");
  if (await rateLocator.count()) {
    rateText = await rateLocator.innerText().catch(() => "");
  }

  const bodyText = `${rateText}\n${await page.locator("body").innerText()}`;
  saveDebugText(source.provider, bodyText);

  let rate = null;

  const patterns = [
    /Rate\s*£1\s*:\s*GHS\s*([0-9.]+)/i,
    /£1\s*:\s*GHS\s*([0-9.]+)/i,
    /1\s*GBP\s*=\s*([0-9.]+)\s*GHS/i,
  ];

  for (const regex of patterns) {
    const match = bodyText.match(regex);
    if (!match) continue;

    const candidate = parseLocaleNumber(match[1]);
    if (candidate && candidate >= 10 && candidate <= 25) {
      rate = Number(candidate.toFixed(6));
      break;
    }
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract Mukuru rate.${file ? ` Screenshot: ${file}` : ""}`);
  }

  return buildResult(source, rate, 0, rate, {
    quoted_send_amount: 100,
  });
}

async function handleXE(page, source) {
  await page.goto("https://www.xe.com/send-money/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(6000);

  await page.getByRole("button", { name: /USD USD/i }).click({
    timeout: 20000,
  });

  const searchBox = page.getByPlaceholder("Search currencies...");
  await searchBox.waitFor({ timeout: 15000 });
  await searchBox.click();
  await searchBox.fill("gh");

  await page.getByRole("option", { name: /GHS GHS Ghanaian Cedi/i }).click({
    timeout: 15000,
  });

  await page.waitForTimeout(5000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  let rate = null;

  const patterns = [
    /GBP\s*=\s*([0-9.]+)\s*GHS/i,
    /1\s*GBP\s*=\s*([0-9.]+)\s*GHS/i,
    /\b(1[0-9]\.\d{2,5})\b/,
  ];

  for (const regex of patterns) {
    const match = bodyText.match(regex);
    if (!match) continue;

    const candidate = parseLocaleNumber(match[1] || match[0]);
    if (candidate && candidate >= 10 && candidate <= 25) {
      rate = Number(candidate.toFixed(6));
      break;
    }
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract XE rate.${file ? ` Screenshot: ${file}` : ""}`);
  }

  return buildResult(source, rate, 0, rate);
}

async function handlePandaRemit(page, source) {
  await page.goto("https://www.pandaremit.com/en/gbr/send-money-to-ghana", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(6000);

  const amountInput = page.getByRole("textbox", { name: "Please Input" }).first();
  await amountInput.waitFor({ timeout: 15000 });
  await amountInput.click({ force: true });
  await amountInput.press("Control+A").catch(() => {});
  await amountInput.fill("100");

  await page.waitForTimeout(5000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  let rate = null;

  // Prefer exact visible quote text
  const patterns = [
    /([0-9.]+)\s*GHS/i,
    /1\s*GBP\s*=\s*([0-9.]+)\s*GHS/i,
    /GBP\s*=\s*([0-9.]+)\s*GHS/i,
  ];

  for (const regex of patterns) {
    const matches = [...bodyText.matchAll(new RegExp(regex.source, "gi"))];
    for (const m of matches) {
      const candidate = parseLocaleNumber(m[1]);
      if (candidate && candidate >= 10 && candidate <= 20) {
        rate = candidate;
        break;
      }
    }
    if (rate) break;
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract PandaRemit rate. Screenshot: ${file}`);
  }

  return buildResult(source, rate, 0, rate, {
    quoted_send_amount: 100,
  });
}

async function handleCurrencyFlow(page, source) {
  await page.goto("https://www.currencyflow.com/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(4000);

  await page.locator("#currency-to-live").selectOption("GHS").catch(() => {});
  await page.waitForTimeout(3000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  let rate = null;
  const patterns = [
    /GBP\s*=\s*([0-9.]+)\s*GHS/i,
    /1\s*GBP\s*=\s*([0-9.]+)\s*GHS/i,
  ];

  for (const regex of patterns) {
    const match = bodyText.match(regex);
    if (!match) continue;
    const candidate = parseLocaleNumber(match[1]);
    if (candidate && candidate >= 10 && candidate <= 20) {
      rate = candidate;
      break;
    }
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract CurrencyFlow rate. Screenshot: ${file}`);
  }

  return buildResult(source, rate, 0, rate);
}

async function handleXoom(page, source) {
  await page.goto("https://www.xoom.com/ghana/send-money", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(6000);

  await page.getByTestId("source-currency-picker").click({
    timeout: 20000,
  });

  await page.getByRole("option", { name: /GBP/i }).click({
    timeout: 15000,
  });

  await page.waitForTimeout(1500);

  await page.getByText("GHS", { exact: true }).click({
    timeout: 15000,
  }).catch(() => {});

  await page.waitForTimeout(3000);

  await page.getByTestId("send-now-button").click({
    timeout: 15000,
  }).catch(() => {});

  await page.waitForTimeout(5000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  let rate = null;

  const patterns = [
    /GBP\s*=\s*([0-9.]+)\s*GHS/i,
    /1\s*GBP\s*=\s*([0-9.]+)\s*GHS/i,
    /\b(1[0-9]\.\d{2,5})\b/,
  ];

  for (const regex of patterns) {
    const match = bodyText.match(regex);
    if (!match) continue;

    const candidate = parseLocaleNumber(match[1] || match[0]);
    if (candidate && candidate >= 10 && candidate <= 25) {
      rate = Number(candidate.toFixed(6));
      break;
    }
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract Xoom rate.${file ? ` Screenshot: ${file}` : ""}`);
  }

  return buildResult(source, rate, 0, rate);
}

async function runSource(browser, source) {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1200 },
  });

  try {
    let payload;

    if (source.provider === "LemFi") payload = await handleLemFi(page, source);
    else if (source.provider === "Sendwave") payload = await handleSendwave(page, source);
    else if (source.provider === "TapTap Send") payload = await handleTapTap(page, source);
    else if (source.provider === "TransferGo") payload = await handleTransferGo(page, source);
    else if (source.provider === "PayAngel") payload = await handlePayAngel(page, source);
    else if (source.provider === "RemitChoice") payload = await handleRemitChoice(page, source);
    else if (source.provider === "RizRemit") payload = await handleRizRemit(page, source);
    else if (source.provider === "Nala") payload = await handleNala(page, source);
    else if (source.provider === "Roze Remit") payload = await handleRozeRemit(page, source);
    else if (source.provider === "UnityLink") payload = await handleUnityLink(page, source);
    else if (source.provider === "Afripay") payload = await handleAfripay(page, source);
    else if (source.provider === "Continental Money") payload = await handleContinentalMoney(page, source);
    else if (source.provider === "FP Transfer") payload = await handleFPTransfer(page, source);
    else if (source.provider === "Instarem") payload = await handleInstarem(page, source);
    else if (source.provider === "JubaExpress") payload = await handleJubaExpress(page, source);
    else if (source.provider === "Jupay") payload = await handleJupay(page, source);
    else if (source.provider === "OaPay") payload = await handleOaPay(page, source);
    else if (source.provider === "Ohent Pay") payload = await handleOhentPay(page, source);
    else if (source.provider === "PadiePay") payload = await handlePadiePay(page, source);
    else if (source.provider === "Paysend") payload = await handlePaysend(page, source);
    else if (source.provider === "Pesa.co") payload = await handlePesaCo(page, source);
    else if (source.provider === "RemitnGo") payload = await handleRemitnGo(page, source);
    else if (source.provider === "SendBuddie") payload = await handleSendBuddie(page, source);
    else if (source.provider === "TransferGalaxy") payload = await handleTransferGalaxy(page, source);
    else if (source.provider === "VeloRemit") payload = await handleVeloRemit(page, source);
    else if (source.provider === "Mukuru") payload = await handleMukuru(page, source);
    else if (source.provider === "XE") payload = await handleXE(page, source);
    else if (source.provider === "PandaRemit") payload = await handlePandaRemit(page, source);
    else if (source.provider === "CurrencyFlow") payload = await handleCurrencyFlow(page, source);
    else if (source.provider === "Xoom") payload = await handleXoom(page, source);
    else throw new Error(`No handler configured for ${source.provider}`);
    await postQuote(payload);
    console.log(`OK: ${source.provider} ${source.origin}->${source.destination}`);
  } finally {
    await page.close();
  }
}

async function main() {
  const sources = JSON.parse(fs.readFileSync("./sources.json", "utf8"));
  const browser = await chromium.launch({ headless: HEADLESS });

  for (const source of sources) {
    try {
      await runSource(browser, source);
    } catch (err) {
      console.error(`FAIL: ${source.provider} - ${err.message}`);
    }
  }

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});