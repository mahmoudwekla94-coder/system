// api/webhook.js

module.exports = async function webhook(req, res) {
  // =========================
  // Health Check
  // =========================
  if (req.method === "GET") {
    return res.status(200).send("Webhook Running ✅");
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const data = req.body || {};

    // =========================
    // Helpers
    // =========================
    const safeText = (t) => {
      if (!t && t !== 0) return "";
      return String(t)
        .replace(/\\[nrt]/g, " ")
        .replace(/[\r\n\t]+/g, " ")
        .replace(/\s{2,}/g, " ")
        .trim();
    };

    const toNumber = (v) =>
      Number(String(v ?? "").replace(/[^0-9.]/g, "")) || 0;

    // =========================
    // Store Tag (WHATWG URL)
    // =========================
    const u = new URL(req.url, `https://${req.headers.host}`);
    const storeTagRaw =
      u.searchParams.get("storeTag") ||
      data.storeTag ||
      data.tag ||
      "EQ";

    const storeTag = String(storeTagRaw).toUpperCase();

    // =========================
    // Store Config (template + lang = ar)
    // =========================
    const storeConfig = {
      EQ: { template: "ordar_confirmation", lang: "ar", currency: "ريال سعودي", defaultCountry: "KSA" },
      BZ: { template: "ordar_confirmation", lang: "ar", currency: "ريال سعودي", defaultCountry: "KSA" },
      GZ: { template: "ordar_confirmation", lang: "ar", currency: "ريال سعودي", defaultCountry: "KSA" },
      SH: { template: "ordar_confirmation", lang: "ar", currency: "ريال سعودي", defaultCountry: "KSA" },
    };

    const cfg = storeConfig[storeTag] || storeConfig.EQ;

    // =========================
    // Detect Shopify Order
    // =========================
    const looksLikeShopify =
      (typeof data.name === "string" && data.name.startsWith("#")) ||
      !!data.shipping_address ||
      !!data.billing_address ||
      (Array.isArray(data.line_items) && data.line_items.length > 0);

    const isShopifyOrder = looksLikeShopify && !data.cart_items;

    // =========================
    // Normalize Phone (E.164)
    // =========================
    function normalizePhone(phone, country = "KSA") {
      if (!phone) return "";
      let raw = String(phone).replace(/[^0-9]/g, "");

      const knownCodes = [
        "966","971","20","249","967","962","965","974","973","968",
        "964","212","213","216","218","970","961","963","222"
      ];

      for (const code of knownCodes) {
        if (raw.startsWith(code)) return `+${raw}`;
      }

      if (raw.startsWith("01") && raw.length === 11) return `+20${raw.substring(1)}`;
      if (raw.startsWith("09") && raw.length === 10) return `+249${raw.substring(1)}`;
      if (raw.startsWith("07") && raw.length === 9)  return `+967${raw.substring(1)}`;
      if (raw.startsWith("07") && raw.length === 10) return `+962${raw.substring(1)}`;

      if (raw.startsWith("05") && raw.length === 10) {
        if (country === "UAE") return `+971${raw.substring(1)}`;
        return `+966${raw.substring(1)}`;
      }

      return raw ? `+${raw}` : "";
    }

    // =========================
    // Data Mapping
    // =========================
    let customerName, customerPhone, orderId, country;
    let productName, quantity = 1;
    let priceRaw = 0, shippingRaw = 0;
    let detailedAddress = "غير متوفر";
    let nationalAddressRaw = "";

    if (isShopifyOrder) {
      const shipping = data.shipping_address || {};
      const billing = data.billing_address || {};
      const items = Array.isArray(data.line_items) ? data.line_items : [];
      const firstItem = items[0] || {};

      const fullName = safeText(`${shipping.first_name || ""} ${shipping.last_name || ""}`);
      customerName =
        fullName ||
        safeText(shipping.name) ||
        safeText(billing.name) ||
        "عميلنا العزيز";

      customerPhone =
        shipping.phone ||
        data.phone ||
        data.customer?.phone ||
        "";

      orderId = data.name || data.order_number || data.id || "";

      country =
        shipping.country_code ||
        shipping.country ||
        cfg.defaultCountry;

      quantity = firstItem.quantity ?? 1;
      productName =
        items.length > 1
          ? `${firstItem.title} + ${items.length - 1} منتجات أخرى`
          : firstItem.title || "منتج";

      priceRaw = firstItem.price ?? data.total_price ?? 0;

      const shippingLine = data.shipping_lines?.[0] || {};
      shippingRaw =
        shippingLine.price ??
        data.total_shipping_price_set?.shop_money?.amount ??
        0;

      detailedAddress = [
        shipping.address1,
        shipping.address2,
        shipping.city,
        shipping.province,
        shipping.zip,
      ].filter(Boolean).join(" - ");

    } else {
      customerName =
        data.full_name ||
        data.name ||
        data.customer_name ||
        "عميلنا العزيز";

      customerPhone =
        data.phone ||
        data.phone_alt ||
        data.customer_phone ||
        "";

      orderId =
        data.short_id ||
        data.order_id ||
        data.id ||
        "";

      country =
        data.country ||
        data.shipping_country ||
        cfg.defaultCountry;

      const firstItem = data.cart_items?.[0] || {};
      quantity = firstItem.quantity ?? 1;
      productName = firstItem.product?.name || "منتج";

      priceRaw =
        firstItem.price ??
        data.total_cost ??
        data.cost ??
        0;

      shippingRaw =
        data.shipping_cost ??
        data.shipping_fee ??
        data.shipping_price ??
        data.delivery_cost ??
        data.shipping ??
        0;

      detailedAddress =
        data.address ||
        data.full_address ||
        data.shipping_address ||
        data.city ||
        "غير متوفر";

      nationalAddressRaw =
        data.national_address ||
        data.short_address ||
        "";
    }

    // =========================
    // Phone
    // =========================
    const e164Phone = normalizePhone(customerPhone, country);
    const digitsPhone = e164Phone.replace(/^\+/, "");

    if (!digitsPhone || digitsPhone.length < 9) {
      return res.status(400).json({ error: "invalid_phone", customerPhone });
    }

    // =========================
    // Prices
    // =========================
    const priceNum = toNumber(priceRaw);
    const shippingNum = toNumber(shippingRaw);
    const totalNum = priceNum + shippingNum;

    const currency = cfg.currency;
    const priceText = priceNum ? `${priceNum} ${currency}` : "غير محدد";
    const shippingText = shippingNum ? `${shippingNum} ${currency}` : "مجاني";
    const totalText = `${totalNum} ${currency}`;

    const nationalAddress =
      safeText(nationalAddressRaw) ||
      "غير متوفر (يرجى تزويدن
