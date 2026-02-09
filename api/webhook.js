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
    // FIXED STORE (TR)
    // =========================
    const storeTag = "TR";
    const currency = "ريال سعودي";
    const defaultCountry = "KSA";

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
    function normalizePhone(phone) {
      if (!phone) return "";
      let raw = String(phone).replace(/[^0-9]/g, "");

      if (raw.startsWith("05") && raw.length === 10) {
        return `+966${raw.substring(1)}`;
      }

      return raw ? `+${raw}` : "";
    }

    // =========================
    // Data Mapping
    // =========================
    let customerName, customerPhone, orderId;
    let productName, quantity = 1;
    let priceRaw = 0, shippingRaw = 0;
    let detailedAddress = "غير متوفر";
    let nationalAddressRaw = "";

    if (isShopifyOrder) {
      const shipping = data.shipping_address || {};
      const items = Array.isArray(data.line_items) ? data.line_items : [];
      const firstItem = items[0] || {};

      customerName =
        safeText(`${shipping.first_name || ""} ${shipping.last_name || ""}`) ||
        "عميلنا العزيز";

      customerPhone =
        shipping.phone ||
        data.phone ||
        "";

      orderId = data.name || data.id || "";

      quantity = firstItem.quantity ?? 1;
      productName = firstItem.title || "منتج";

      priceRaw = firstItem.price ?? data.total_price ?? 0;
      shippingRaw = data.shipping_lines?.[0]?.price ?? 0;

      detailedAddress = [
        shipping.address1,
        shipping.city,
      ].filter(Boolean).join(" - ");

    } else {
      customerName = data.full_name || "عميلنا العزيز";
      customerPhone = data.phone || "";
      orderId = data.order_id || data.id || "";

      const firstItem = data.cart_items?.[0] || {};
      quantity = firstItem.quantity ?? 1;
      productName = firstItem.product?.name || "منتج";

      priceRaw = firstItem.price ?? data.total_cost ?? 0;
      shippingRaw = data.shipping_cost ?? 0;

      detailedAddress = data.address || data.city || "غير متوفر";
      nationalAddressRaw = data.national_address || "";
    }

    // =========================
    // Phone
    // =========================
    const e164Phone = normalizePhone(customerPhone);
    const digitsPhone = e164Phone.replace(/^\+/, "");

    if (!digitsPhone || digitsPhone.length < 9) {
      return res.status(400).json({ error: "invalid_phone" });
    }

    // =========================
    // Prices
    // =========================
    const priceNum = toNumber(priceRaw);
    const shippingNum = toNumber(shippingRaw);
    const totalNum = priceNum + shippingNum;

    const priceText = `${priceNum} ${currency}`;
    const shippingText = shippingNum ? `${shippingNum} ${currency}` : "مجاني";
    const totalText = `${totalNum} ${currency}`;

    const nationalAddress =
      safeText(nationalAddressRaw) ||
      "غير متوفر (يرجى تزويدنا بالعنوان الوطني)";

    // =========================
    // ENV
    // =========================
    const API_BASE_URL = process.env.SAAS_API_BASE_URL;
    const VENDOR_UID = process.env.SAAS_VENDOR_UID;
    const API_TOKEN = process.env.SAAS_API_TOKEN;

    if (!API_BASE_URL || !VENDOR_UID || !API_TOKEN) {
      return res.status(500).json({ error: "missing_env" });
    }

    // =========================
    // WhatsApp Payload
    // =========================
    const payload = {
      phone_number: digitsPhone,
      template_name: "ordar_confirmation",
      template_language: "ar",

      field_1: safeText(customerName),
      field_2: `${orderId} (TR)`,
      field_3: safeText(productName),
      field_4: quantity,
      field_5: priceText,
      field_6: shippingText,
      field_7: totalText,
      field_8: detailedAddress,
      field_9: nationalAddress,

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

    return res.status(200).json({ status: "sent", store: "TR" });

  } catch (err) {
    return res.status(500).json({
      error: "internal_error",
      details: err?.message || String(err),
    });
  }
};
