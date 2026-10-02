/**
 * VANTA — نظام الطلبات الآلي (Google Apps Script)
 * ==================================================================
 * ملفات هذا المشروع داخل Apps Script:
 *   1) Catalog.gs   — بيانات المنتجات والأسعار (مولّد من catalog.json)
 *   2) Pricing.gs   — محرك الحساب (مولّد من src/pricing-core.js) — نفس كود الموقع حرفيًا
 *   3) Code.gs      — هذا الملف: الاستقبال، التحقق، الحفظ في الشيت
 *
 * قاعدة ذهبية: السيرفر لا يثق في أي رقم قادم من المتصفح.
 * يعيد حساب كل شيء من الصفر بمحرك التسعير ثم يقارن النتيجة بما أرسله الموقع
 * ويحفظ الاثنين معًا في عمود "مطابقة الحساب" لأي مراجعة لاحقة.
 *
 * طريقة النشر: انشر > نشر كتطبيق ويب > نفّذ بصفتي: أنا > من يمكنه الوصول: أي شخص
 */

/* ============================ الإعدادات ============================ */

var CONFIG = {
  SHEET_NAME: 'الطلبات',
  HEADER_ROW: 1,
  TIMEZONE: 'Asia/Riyadh',
  OWNER_EMAIL: '',            // بريد استلام إشعار الطلبات (اتركه فارغًا لتعطيل الإشعار)
  SEND_EMAIL: false,          // true لتفعيل إرسال إيميل تأكيد للعميل ونسخة للإدارة
  COMPANY_NAME: 'فانتا VANTA'
};

/* ======================= تجهيز الشيت (مرة واحدة) =================== */

var COLUMNS = [
  'رقم الطلب', 'التاريخ والوقت', 'الحالة',
  'المنتج', 'معرف المنتج', 'الكمية', 'المواصفات',
  'إنتاج عاجل', 'توصيل مطلوب',
  'سعر الوحدة', 'قيمة الإنتاج', 'الرسوم الثابتة', 'رسوم الاستعجال', 'رسوم التوصيل',
  'الخاضع للضريبة', 'الضريبة', 'الإجمالي النهائي', 'العملة',
  'اسم العميل', 'الشركة', 'الجوال', 'البريد', 'المدينة', 'ملاحظات',
  'إجمالي الموقع (للمطابقة)', 'مطابقة الحساب', 'بصمة الحساب', 'إصدار المحرك', 'مدة التنفيذ (يوم)'
];

/**
 * ينشئ ورقة الطلبات وتنسيقها إن لم تكن موجودة.
 * شغّل هذه الدالة مرة واحدة من محرر السكربت بعد النسخ.
 */
function setupSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.SHEET_NAME);
  }
  sheet.clear();
  sheet.getRange(1, 1, 1, COLUMNS.length).setValues([COLUMNS]);
  var header = sheet.getRange(1, 1, 1, COLUMNS.length);
  header.setFontWeight('bold')
        .setBackground('#101014')
        .setFontColor('#ffffff')
        .setVerticalAlignment('middle')
        .setWrap(true);
  sheet.setFrozenRows(1);
  sheet.setFrozenColumns(3);
  sheet.setRowHeight(1, 42);

  // أعمدة المبالغ: تنسيق رقمي بفاصلة
  var moneyCols = [10, 11, 12, 13, 14, 15, 16, 17, 26];
  moneyCols.forEach(function (c) {
    sheet.getRange(2, c, Math.max(sheet.getMaxRows() - 1, 1), 1).setNumberFormat('#,##0.00');
  });

  // تحويل المبالغ من وحداتها الصغرى إلى وحدات كاملة لسهولة القراءة
  // (تُحفظ القيم الصحيحة في عمود مخفي؟ لا — نحفظ القيم كما هي بوحداتها الصغرى في "الإجمالي النهائي"
  //  ونضيف أعمدة مقروءة أدناه)
  sheet.getRange(1, COLUMNS.length + 1).setValue('الإجمالي (مقروء)');
  sheet.getRange(1, COLUMNS.length + 2).setValue('الضريبة (مقروءة)');
  sheet.getRange(1, 1, 1, COLUMNS.length + 2).setBackground('#101014').setFontColor('#ffffff').setFontWeight('bold');

  // ملاحظة توضيحية في أعلى كل عمود مبلغ
  sheet.getRange(1, 10, 1, 8).setNote('القيم محفوظة بالهللة (أصغر وحدة) كأعداد صحيحة — لا أرقام عشرية إطلاقًا.');
  sheet.getRange(1, 17).setNote('الإجمالي النهائي المعتمد = الخاضع للضريبة + الضريبة');

  // تنسيق الأعمدة
  sheet.setColumnWidths(1, 3, 120);
  sheet.setColumnWidth(7, 320);   // المواصفات
  sheet.setColumnWidth(25, 300);  // ملاحظات

  SpreadsheetApp.getActiveSpreadsheet().setActiveSheet(sheet);
  return 'تم تجهيز ورقة "' + CONFIG.SHEET_NAME + '" بنجاح. عدد الأعمدة: ' + COLUMNS.length;
}

/* ============================ الاستقبال ============================ */

/**
 * استقبال طلب جديد من الموقع (POST).
 * الموقع يرسل: JSON.stringify({ productId, qty, selections, rush, delivery, customer, clientTotal })
 */
function doPost(e) {
  var lock = LockService.getScriptLock();
  var locked = false;
  try {
    lock.waitLock(25000);
    locked = true;
  } catch (err) {
    return jsonOut({ ok: false, errors: ['النظام مشغول، أعد المحاولة بعد ثوانٍ'] });
  }

  try {
    var raw = '';
    if (e && e.postData && e.postData.contents) {
      raw = e.postData.contents;
    } else if (e && e.parameter && e.parameter.payload) {
      raw = e.parameter.payload;
    }
    if (!raw) return jsonOut({ ok: false, errors: ['لم يصل أي بيانات'] });
    if (raw.length > 30000) return jsonOut({ ok: false, errors: ['حجم الطلب كبير جدًا'] });

    var body;
    try {
      body = JSON.parse(raw);
    } catch (err) {
      return jsonOut({ ok: false, errors: ['بيانات غير قابلة للقراءة'] });
    }

    // 1) التحقق من بيانات العميل
    var customer = body.customer || {};
    var custErrors = validateCustomer(customer);

    // 2) إعادة الحساب من الصفر على السيرفر (المصدر الموثوق)
    var quoteInput = {
      productId: body.productId,
      qty: body.qty,
      selections: body.selections,
      rush: !!body.rush,
      delivery: !!body.delivery
    };

    var catalogErrors = VANTA_PRICING.validateCatalog(CATALOG);
    if (catalogErrors.length) {
      // لا يُفترض حدوثه أبدًا — لكن لو حدث نوقف الاستلام بدل تسجيل أرقام خاطئة
      return jsonOut({ ok: false, errors: ['خطأ في إعدادات الأسعار، تواصل مع الإدارة'] , debug: catalogErrors });
    }

    var quote = VANTA_PRICING.computeQuote(CATALOG, quoteInput);
    if (!quote.ok) {
      return jsonOut({ ok: false, errors: quote.errors.concat(custErrors) });
    }
    if (custErrors.length) {
      return jsonOut({ ok: false, errors: custErrors });
    }

    var d = quote.data;

    // 3) مطابقة حساب الموقع مع حساب السيرفر
    var clientTotal = parseInt(body.clientTotal, 10);
    var match = 'غير محدّد';
    if (body.clientTotal === undefined || body.clientTotal === null || isNaN(clientTotal)) {
      match = 'لا يوجد';
    } else {
      match = (clientTotal === d.total) ? 'مطابق ✓' : 'اختلاف ⚠ (المعتمد: السيرفر)';
    }

    // 4) الحفظ في الشيت
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(CONFIG.SHEET_NAME) || createSheet();
    var ts = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm:ss');
    var orderNo = nextOrderNo(sheet);

    var row = [
      orderNo, ts, 'جديد',
      d.productName, d.productId, d.qty, describeSelections(d),
      d.rush ? 'نعم' : 'لا', body.delivery ? 'نعم' : 'لا',
      d.perUnit, d.production, d.flats, d.rush, d.delivery,
      d.taxable, d.tax, d.total, d.currency.code,
      customer.name || '', customer.company || '', customer.phone || '',
      customer.email || '', customer.city || '', customer.notes || '',
      isNaN(clientTotal) ? '' : clientTotal, match, d.calcHash,
      VANTA_PRICING.PRICING_VERSION, d.leadTimeDays
    ];
    sheet.appendRow(row);

    // أعمدة مقروءة (بالوحدات الكاملة)
    var lastRow = sheet.getLastRow();
    var minorUnits = Math.pow(10, d.currency.minorUnits);
    sheet.getRange(lastRow, COLUMNS.length + 1, 1, 2)
         .setValues([[d.total / minorUnits, d.tax / minorUnits]])
         .setNumberFormat('#,##0.00');

    // 5) إشعار اختياري
    if (CONFIG.SEND_EMAIL && CONFIG.OWNER_EMAIL) {
      try {
        MailApp.sendEmail({
          to: CONFIG.OWNER_EMAIL,
          subject: 'طلب جديد ' + orderNo + ' — ' + (customer.company || customer.name),
          htmlBody: buildEmailHtml(orderNo, d, customer, match)
        });
      } catch (mailErr) { /* لا نفشل الطلب بسبب الإيميل */ }
    }
    if (CONFIG.SEND_EMAIL && customer.email) {
      try {
        MailApp.sendEmail({
          to: customer.email,
          subject: 'تم استلام طلبك ' + orderNo + ' — ' + CONFIG.COMPANY_NAME,
          htmlBody: buildCustomerEmailHtml(orderNo, d, customer)
        });
      } catch (mailErr) { /* تجاهل */ }
    }

    return jsonOut({
      ok: true,
      orderNo: orderNo,
      timestamp: ts,
      match: match,
      totals: {
        perUnit: d.perUnit, production: d.production, flats: d.flats,
        rush: d.rush, delivery: d.delivery, taxable: d.taxable,
        tax: d.tax, total: d.total, currency: d.currency,
        totalFormatted: VANTA_PRICING.formatMoney(d.total, d.currency)
      },
      leadTimeDays: d.leadTimeDays,
      calcHash: d.calcHash,
      pricingVersion: VANTA_PRICING.PRICING_VERSION
    });

  } catch (err) {
    return jsonOut({ ok: false, errors: ['حدث خطأ غير متوقع: ' + (err && err.message ? err.message : err)] });
  } finally {
    if (locked) lock.releaseLock();
  }
}

/**
 * GET: فحص صحة السكربت + إرجاع الكتالوج (مفيد لمزامنة الموقع لاحقًا).
 * مثال: ?action=ping   |   ?action=catalog
 */
function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) || 'ping';
  if (action === 'catalog') {
    return jsonOut({ ok: true, catalog: CATALOG });
  }
  if (action === 'quote') {
    var q = VANTA_PRICING.computeQuote(CATALOG, {
      productId: e.parameter.productId,
      qty: parseInt(e.parameter.qty, 10),
      selections: e.parameter.selections ? JSON.parse(e.parameter.selections) : undefined,
      rush: e.parameter.rush === '1',
      delivery: e.parameter.delivery === '1'
    });
    return jsonOut(q);
  }
  var errors = VANTA_PRICING.validateCatalog(CATALOG);
  return jsonOut({
    ok: errors.length === 0,
    service: 'VANTA Orders API',
    pricingVersion: VANTA_PRICING.PRICING_VERSION,
    products: CATALOG.products.length,
    catalogErrors: errors,
    sheet: CONFIG.SHEET_NAME
  });
}

/* ============================ مساعدات ============================ */

function createSheet() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().insertSheet(CONFIG.SHEET_NAME);
  sheet.getRange(1, 1, 1, COLUMNS.length).setValues([COLUMNS]);
  sheet.getRange(1, 1, 1, COLUMNS.length).setFontWeight('bold').setBackground('#101014').setFontColor('#ffffff');
  sheet.setFrozenRows(1);
  return sheet;
}

function jsonOut(obj) {
  var out = ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
  // السماح للمتصفح بقراءة الاستجابة (Apps Script يعيد التوجيه لمرة واحدة)
  return out;
}

function validateCustomer(c) {
  var errors = [];
  var name = (c.name || '').toString().trim();
  var phone = (c.phone || '').toString().trim();
  var email = (c.email || '').toString().trim();

  if (name.length < 3) errors.push('الاسم مطلوب (٣ أحرف على الأقل)');
  if (name.length > 80) errors.push('الاسم طويل جدًا');

  var digits = phone.replace(/[^\d]/g, '');
  if (digits.length < 9 || digits.length > 15) errors.push('رقم الجوال غير صحيح');

  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) errors.push('صيغة البريد الإلكتروني غير صحيحة');
  if ((c.notes || '').length > 1000) errors.push('الملاحظات طويلة جدًا (١٠٠٠ حرف كحد أقصى)');
  if ((c.company || '').length > 120) errors.push('اسم الشركة طويل جدًا');
  return errors;
}

/** يبني نصًا مقروءًا للمواصفات المختارة ليُحفظ في الشيت */
function describeSelections(d) {
  var product = null;
  for (var i = 0; i < CATALOG.products.length; i++) {
    if (CATALOG.products[i].id === d.productId) product = CATALOG.products[i];
  }
  if (!product) return JSON.stringify(d.selections);

  var parts = [];
  (product.groups || []).forEach(function (g) {
    var chosen = d.selections[g.id];
    if (g.type === 'multi') {
      (chosen || []).forEach(function (id) {
        var o = findOption(g, id);
        if (o) parts.push(g.label + ': ' + o.label);
      });
    } else {
      var o2 = findOption(g, chosen);
      if (o2) parts.push(g.label + ': ' + o2.label);
    }
  });
  return parts.join(' | ');
}

function findOption(group, id) {
  for (var i = 0; i < group.options.length; i++) {
    if (group.options[i].id === id) return group.options[i];
  }
  return null;
}

/** رقم طلب متسلسل يومي: V-20261002-0001 (آمن مع الطلبات المتزامنة) */
function nextOrderNo(sheet) {
  var stamp = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyyMMdd');
  var prefix = 'V-' + stamp + '-';
  var props = PropertiesService.getScriptProperties();
  var key = 'seq_' + stamp;
  var last = parseInt(props.getProperty(key) || '0', 10);

  // fallback: لو ضاعت الخاصية، نقرأ آخر رقم من الشيت
  if (!last) {
    var lastRow = sheet.getLastRow();
    if (lastRow > 1) {
      var val = sheet.getRange(lastRow, 1).getValue().toString();
      var m = val.match(/-(\d{4})$/);
      if (m) last = parseInt(m[1], 10);
    }
  }
  var next = last + 1;
  props.setProperty(key, String(next));
  return prefix + ('0000' + next).slice(-4);
}

function buildEmailHtml(orderNo, d, customer, match) {
  var lines = d.lines.map(function (l) {
    return '<tr><td style="padding:6px;border-bottom:1px solid #eee">' + l.label +
           '</td><td style="padding:6px;border-bottom:1px solid #eee">' +
           VANTA_PRICING.formatMoney(l.amount, d.currency) + '</td></tr>';
  }).join('');
  return '<div dir="rtl" style="font-family:Tahoma,sans-serif">' +
    '<h2>طلب جديد: ' + orderNo + '</h2>' +
    '<p><b>العميل:</b> ' + escapeHtml(customer.name) + ' — ' + escapeHtml(customer.company || '') + '</p>' +
    '<p><b>الجوال:</b> ' + escapeHtml(customer.phone) + '</p>' +
    '<p><b>المنتج:</b> ' + d.productName + ' — الكمية: ' + d.qty + '</p>' +
    '<p><b>المواصفات:</b> ' + describeSelections(d) + '</p>' +
    '<table style="border-collapse:collapse;width:100%">' + lines + '</table>' +
    '<h3 style="color:#0a7">الإجمالي: ' + VANTA_PRICING.formatMoney(d.total, d.currency) + '</h3>' +
    '<p>مطابقة حساب الموقع: ' + match + ' | بصمة: ' + d.calcHash + '</p>' +
    '</div>';
}

function buildCustomerEmailHtml(orderNo, d, customer) {
  return '<div dir="rtl" style="font-family:Tahoma,sans-serif">' +
    '<h2>شكرًا لك ' + escapeHtml(customer.name) + '</h2>' +
    '<p>تم استلام طلبك رقم <b>' + orderNo + '</b> وسيتم التواصل معك خلال يوم عمل.</p>' +
    '<p><b>' + d.productName + '</b> — الكمية: ' + d.qty + ' ' + d.unitLabel + '</p>' +
    '<p>الإجمالي: <b>' + VANTA_PRICING.formatMoney(d.total, d.currency) + '</b></p>' +
    '<p>مدة التنفيذ التقديرية: ' + d.leadTimeDays + ' يوم</p>' +
    '<p style="color:#888">' + CONFIG.COMPANY_NAME + '</p>' +
    '</div>';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

/* ====================== اختبار ذاتي داخل Apps Script ============== */
/**
 * شغّل هذه الدالة من المحرر بعد النسخ للتأكد أن كل شيء يعمل:
 *   النتيجة يجب أن تكون: "PASS — كل الاختبارات ناجحة"
 */
function selfTest() {
  var log = [];
  function check(name, actual, expected) {
    if (String(actual) !== String(expected)) {
      log.push('FAIL: ' + name + ' (الفعلي ' + actual + ' / المتوقع ' + expected + ')');
    } else {
      log.push('ok: ' + name);
    }
  }

  // 1) سلامة الكتالوج
  var errs = VANTA_PRICING.validateCatalog(CATALOG);
  check('كتالوج سليم', errs.length, 0);

  // 2) حالة مرجعية ثابتة (كيس ورقي 500 وسط كرافت لونان حبل قطني)
  var paper = CATALOG.products[0];
  var sel = VANTA_PRICING.normalizeSelections(paper);
  sel.size = 'm'; sel.material = 'kraft120'; sel.print = '2c1s'; sel.handle = 'cotton'; sel.finish = 'none'; sel.extras = [];
  var r = VANTA_PRICING.computeQuote(CATALOG, { productId: paper.id, qty: 500, selections: sel, delivery: true });
  check('حالة مرجعية ok', r.ok, true);
  check('سعر الوحدة', r.data && r.data.perUnit, 370);
  check('قيمة الإنتاج', r.data && r.data.production, 185000);
  check('الإجمالي', r.data && r.data.total, 270250);

  // 3) رفض كمية غير صالحة
  check('رفض كمية أقل من الحد', VANTA_PRICING.computeQuote(CATALOG, { productId: paper.id, qty: 1, selections: sel }).ok, false);

  // 4) كل منتج: تحقق من تطابق الإجمالي مع بنوده على كمية الحد الأدنى
  var bad = 0;
  CATALOG.products.forEach(function (p) {
    var s2 = VANTA_PRICING.normalizeSelections(p);
    var q = VANTA_PRICING.computeQuote(CATALOG, { productId: p.id, qty: p.minQty, selections: s2, rush: true, delivery: true });
    if (!q.ok) { bad++; return; }
    if (q.data.total !== q.data.taxable + q.data.tax) bad++;
    if (q.data.production !== q.data.perUnit * q.data.qty) bad++;
    if (!Number.isSafeInteger(q.data.total)) bad++;
  });
  check('كل المنتجات متسقة حسابيًا', bad, 0);

  // 5) الورقة موجودة؟
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEET_NAME);
  check('ورقة الطلبات موجودة', !!sheet, true);

  var failed = log.filter(function (l) { return l.indexOf('FAIL') === 0; });
  var msg = failed.length ? ('FAIL:\n' + failed.join('\n')) : 'PASS — كل الاختبارات ناجحة (' + log.length + ' فحص)';
  Logger.log(msg + '\n\n' + log.join('\n'));
  return msg;
}
