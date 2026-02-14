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
    // Store Tag
    // =========================
    const u = new URL(req.url, `https://${req.headers.host}`);
    const storeTagRaw =
      u.searchParams.get("storeTag") ||
      data.storeTag ||
      data.tag ||
      "EQ";

    const storeTag = String(storeTagRaw).toUpperCase();

    // =========================
    // Store Config
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
    // Normalize Phone
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
      const items = Array.isArray(data.line_items) ? data.line_items : [];
      const firstItem = items[0] || {};

      const fullName = safeText(`${shipping.first_name || ""} ${shipping.last_name || ""}`);
      customerName = fullName || safeText(shipping.name) || "عميلنا العزيز";

      customerPhone = shipping.phone || data.phone || "";

      orderId = data.name || data.order_number || data.id || "";

      country = shipping.country_code || shipping.country || cfg.defaultCountry;

      quantity = firstItem.quantity ?? 1;

      productName =
        items.length > 1
          ? `${firstItem.title} + ${items.length - 1} منتجات أخرى`
          : firstItem.title || "منتج";

      priceRaw = firstItem.price ?? data.total_price ?? 0;

      const shippingLine = data.shipping_lines?.[0] || {};
      shippingRaw = shippingLine.price ?? 0;

      detailedAddress = [
        shipping.address1,
        shipping.city,
        shipping.province,
        shipping.zip,
      ].filter(Boolean).join(" - ");

    } else {
      customerName = data.full_name || data.name || "عميلنا العزيز";
      customerPhone = data.phone || "";
      orderId = data.short_id || data.order_id || data.id || "";
      country = data.country || cfg.defaultCountry;

      const firstItem = data.cart_items?.[0] || {};
      quantity = firstItem.quantity ?? 1;
      productName = firstItem.product?.name || "منتج";
      priceRaw = firstItem.price ?? data.total_cost ?? 0;
      shippingRaw = data.shipping_cost ?? 0;
      detailedAddress = data.address || "غير متوفر";
      nationalAddressRaw = data.national_address || "";
    }

    const e164Phone = normalizePhone(customerPhone, country);
    const digitsPhone = e164Phone.replace(/^\+/, "");

    if (!digitsPhone || digitsPhone.length < 9) {
      return res.status(400).json({ error: "invalid_phone", customerPhone });
    }

    const priceNum = toNumber(priceRaw);
    const shippingNum = toNumber(shippingRaw);
    const totalNum = priceNum + shippingNum;

    const currency = cfg.currency;
    const priceText = priceNum ? `${priceNum} ${currency}` : "غير محدد";
    const shippingText = shippingNum ? `${shippingNum} ${currency}` : "مجاني";
    const totalText = `${totalNum} ${currency}`;

    const nationalAddress =
      safeText(nationalAddressRaw) ||
      "غير متوفر (يرجى تزويدنا بالعنوان الوطني)";

    const API_BASE_URL = process.env.SAAS_API_BASE_URL;
    const VENDOR_UID = process.env.SAAS_VENDOR_UID;
    const API_TOKEN = process.env.SAAS_API_TOKEN;

    if (!API_BASE_URL || !VENDOR_UID || !API_TOKEN) {
      return res.status(500).json({ error: "missing_env" });
    }

    const payload = {
      phone_number: digitsPhone,
      template_name: "ordar_confirmation",
      template_language: "ar",

      field_1: safeText(customerName),
      field_2: safeText(`${orderId} (${storeTag})`),
      field_3: safeText(productName),
      field_4: safeText(quantity),
      field_5: safeText(priceText),
      field_6: safeText(shippingText),
      field_7: safeText(totalText),
      field_8: safeText(detailedAddress),
      field_9: safeText(nationalAddress),

      contact: {
        first_name: safeText(customerName),
        phone_number: digitsPhone,
        country: "auto",
      },
    };

    const endpoint = `${API_BASE_URL}/${VENDOR_UID}/contact/send-template-message`;

    const saasRes = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_TOKEN}`,
      },
      body: JSON.stringify(payload),
    });

    const responseData = await saasRes.json().catch(() => null);

    if (!saasRes.ok || responseData?.result === "failed") {
      return res.status(500).json({ error: "saas_error", responseData });
    }

    return res.status(200).json({ status: "sent", storeTag, data: responseData });

  } catch (err) {
    return res.status(500).json({
      error: "internal_error",
      details: err?.message || String(err),
    });
  }
};
