/* ملف مولّد آليًا من src/pricing-core.js — لا تعدّله يدويًا */
/*!
 * VANTA — محرك التسعير الموحّد (Pricing Core)
 * ------------------------------------------------------------------
 * هذا الملف هو "المصدر الوحيد للحقيقة" في كل ما يخص الحسابات.
 * نفس السطر يُستخدم في:
 *   1) الموقع (assets/vanta-pricing.js)
 *   2) Google Apps Script (google-apps-script/Pricing.gs)
 * ويتم نسخه آليًا عبر tools/build.mjs — لا تعدّل النسختين يدويًا.
 *
 * قواعد صارمة لمنع أي خطأ حسابي:
 *   - كل المبالغ أعداد صحيحة بأصغر وحدة (هللة/فلس). لا يوجد أي رقم عشري.
 *   - كل النسب تُحسب بوحدة "نقطة أساس" (bps): 10000 bps = 100%.
 *   - الضرب في النسب يتم بـ BigInt (حساب صحيح بلا أي خطأ فاصلة عائمة).
 *   - التقريب موحّد: نصف للأعلى (Half-Up) عند قيمة موجبة فقط.
 *   - ترتيب العمليات ثابت وموثّق أدناه ولا يتغير.
 *
 * ترتيب العمليات (ORDER OF OPERATIONS):
 *   1) perUnit   = سعر شريحة الكمية + مجموع دلتا الخيارات (لكل وحدة)
 *   2) production= perUnit × الكمية
 *   3) flats     = مجموع الرسوم الثابتة للخيارات + رسوم التجهيز الأساسية للمنتج
 *   4) rush      = round( (production + flats) × rushPctBps / 10000 )   [إن طُلب]
 *   5) delivery  = (production + flats) >= freeDeliveryThreshold ? 0 : deliveryFee  [إن طُلب التوصيل]
 *   6) taxable   = production + flats + rush + delivery
 *   7) tax       = round( taxable × taxBps / 10000 )
 *   8) total     = taxable + tax
 */
var VANTA_PRICING = (function () {
  'use strict';

  var PRICING_VERSION = '1.0.0';

  var BPS = 10000;
  var ORDER_OF_OPERATIONS = [
    '1) perUnit = سعر شريحة الكمية + مجموع دلتا الخيارات',
    '2) production = perUnit × الكمية',
    '3) flats = مجموع رسوم الخيارات الثابتة + رسوم تجهيز المنتج',
    '4) rush = تقريب((production + flats) × rushPctBps / 10000)',
    '5) delivery = (production + flats) >= حد الشحن المجاني ? 0 : رسوم التوصيل',
    '6) taxable = production + flats + rush + delivery',
    '7) tax = تقريب(taxable × taxBps / 10000)',
    '8) total = taxable + tax'
  ];

  /* ------------------------------------------------------------------ */
  /* أدوات رقمية آمنة                                                     */
  /* ------------------------------------------------------------------ */

  function isInt(n) {
    return typeof n === 'number' && isFinite(n) && Math.floor(n) === n;
  }

  /** تحويل آمن إلى عدد صحيح (يرجع null عند الفشل بدل NaN) */
  function toInt(v, fallback) {
    if (v === null || v === undefined || v === '') return fallback === undefined ? null : fallback;
    if (typeof v === 'number') {
      if (!isFinite(v)) return fallback === undefined ? null : fallback;
      return Math.floor(v);
    }
    if (typeof v === 'string') {
      // إزالة الفراغات والفواصل والمسافات العربية قبل التحويل
      var s = v.replace(/[\s,٬\u00A0\u200F\u200E]/g, '');
      if (!/^-?\d+$/.test(s)) return fallback === undefined ? null : fallback;
      return parseInt(s, 10);
    }
    return fallback === undefined ? null : fallback;
  }

  /**
   * ضرب عدد صحيح في نسبة بالنقاط الأساسية مع تقريب نصف للأعلى.
   * محسوب بالكامل بـ BigInt => نتيجة صحيحة 100% بلا أخطاء الفاصلة العائمة.
   */
  function applyBpsRoundHalfUp(amount, bps) {
    if (!isInt(amount) || !isInt(bps)) return null;
    var neg = amount < 0;
    var a = BigInt(Math.abs(amount));
    var b = BigInt(Math.abs(bps));
    var den = BigInt(BPS);
    var num = a * b;
    var q = num / den;
    var rem = num % den;
    if (rem * BigInt(2) >= den) q = q + BigInt(1);
    var out = Number(q);
    if (!Number.isSafeInteger(out)) return null;
    return neg ? -out : out;
  }

  /** تنسيق مبلغ (بوحداته الصغرى) للعرض: 123456 -> "1,234.56" */
  function formatMoney(minor, currency) {
    var cur = currency || { symbol: '', minorUnits: 2 };
    var units = cur.minorUnits === undefined ? 2 : cur.minorUnits;
    var negative = minor < 0;
    var n = Math.abs(toInt(minor, 0));
    var div = Math.pow(10, units);
    var whole = Math.floor(n / div);
    var frac = String(n % div);
    while (frac.length < units) frac = '0' + frac;
    var wholeStr = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    var out = units > 0 ? wholeStr + '.' + frac : wholeStr;
    if (negative) out = '-' + out;
    return cur.symbol ? out + ' ' + cur.symbol : out;
  }

  /** بصمة نصية ثابتة للمدخلات + النتيجة، تُخزّن في الشيت للتحقق اللاحق */
  function calcHash(obj) {
    var str = stableStringify(obj);
    var h1 = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h1 ^= str.charCodeAt(i);
      h1 = (h1 + ((h1 << 1) + (h1 << 4) + (h1 << 7) + (h1 << 8) + (h1 << 24))) >>> 0;
    }
    return ('00000000' + h1.toString(16)).slice(-8);
  }

  function stableStringify(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) {
      return '[' + value.map(stableStringify).join(',') + ']';
    }
    var keys = Object.keys(value).sort();
    return '{' + keys.map(function (k) { return JSON.stringify(k) + ':' + stableStringify(value[k]); }).join(',') + '}';
  }

  /* ------------------------------------------------------------------ */
  /* التحقق من سلامة الكتالوج (يمنع بيانات تسبب حسابًا خاطئًا)             */
  /* ------------------------------------------------------------------ */

  function validateCatalog(catalog) {
    var errors = [];
    if (!catalog || typeof catalog !== 'object') return ['الكتالوج فارغ أو غير صالح'];

    var settings = catalog.settings || {};
    var currency = settings.currency || {};
    if (!currency.code) errors.push('settings.currency.code مفقود');
    if (!isInt(currency.minorUnits) || currency.minorUnits < 0 || currency.minorUnits > 4) {
      errors.push('settings.currency.minorUnits يجب أن يكون رقمًا صحيحًا بين 0 و 4');
    }
    if (!isInt(settings.taxBps) || settings.taxBps < 0 || settings.taxBps > BPS) {
      errors.push('settings.taxBps يجب أن يكون عددًا صحيحًا بين 0 و 10000');
    }
    if (!isInt(settings.rushPctBps) || settings.rushPctBps < 0 || settings.rushPctBps > BPS) {
      errors.push('settings.rushPctBps يجب أن يكون عددًا صحيحًا بين 0 و 10000');
    }
    if (!isInt(settings.deliveryFee) || settings.deliveryFee < 0) {
      errors.push('settings.deliveryFee يجب أن يكون عددًا صحيحًا ≥ 0');
    }
    if (!isInt(settings.freeDeliveryThreshold) || settings.freeDeliveryThreshold < 0) {
      errors.push('settings.freeDeliveryThreshold يجب أن يكون عددًا صحيحًا ≥ 0');
    }
    if (!isInt(settings.maxQty) || settings.maxQty < 1) {
      errors.push('settings.maxQty يجب أن يكون عددًا صحيحًا ≥ 1');
    }

    if (!Array.isArray(catalog.products) || catalog.products.length === 0) {
      errors.push('لا توجد منتجات في الكتالوج');
      return errors;
    }

    var seenProducts = {};
    catalog.products.forEach(function (p) {
      var tag = 'المنتج "' + (p && p.id ? p.id : '؟') + '"';

      if (!p || !p.id) { errors.push('منتج بدون معرّف id'); return; }
      if (seenProducts[p.id]) errors.push(tag + ': معرّف مكرر');
      seenProducts[p.id] = true;

      if (!p.name) errors.push(tag + ': الاسم مفقود');
      if (!isInt(p.minQty) || p.minQty < 1) errors.push(tag + ': minQty يجب أن يكون عددًا صحيحًا ≥ 1');
      if (p.qtyStep !== undefined && (!isInt(p.qtyStep) || p.qtyStep < 0)) {
        errors.push(tag + ': qtyStep يجب أن يكون عددًا صحيحًا ≥ 0');
      }
      if (p.setupFee !== undefined && (!isInt(p.setupFee) || p.setupFee < 0)) {
        errors.push(tag + ': setupFee يجب أن يكون عددًا صحيحًا ≥ 0');
      }

      // الشرائح
      if (!Array.isArray(p.tiers) || p.tiers.length === 0) {
        errors.push(tag + ': لا توجد شرائح أسعار');
      } else {
        var prevMin = -1;
        var prevPrice = null;
        p.tiers.forEach(function (t, idx) {
          if (!isInt(t.minQty) || t.minQty < 1) {
            errors.push(tag + ': شريحة #' + (idx + 1) + ' minQty غير صالح');
          } else {
            if (t.minQty <= prevMin) {
              errors.push(tag + ': شرائح غير مرتبة تصاعديًا عند الشريحة #' + (idx + 1));
            }
            prevMin = t.minQty;
          }
          if (!isInt(t.unitPrice) || t.unitPrice < 0) {
            errors.push(tag + ': شريحة #' + (idx + 1) + ' unitPrice يجب أن يكون عددًا صحيحًا ≥ 0');
          }
          if (prevPrice !== null && isInt(t.unitPrice) && t.unitPrice > prevPrice) {
            errors.push(tag + ': تحذير — سعر الشريحة #' + (idx + 1) + ' أعلى من الشريحة الأقل (تحقق من البيانات)');
          }
          if (isInt(t.unitPrice)) prevPrice = t.unitPrice;
        });
        if (isInt(p.minQty) && p.tiers[0].minQty !== p.minQty) {
          errors.push(tag + ': أول شريحة يجب أن تبدأ بنفس minQty (' + p.minQty + ')');
        }
      }

      // المجموعات والخيارات
      if (!Array.isArray(p.groups) || p.groups.length === 0) {
        errors.push(tag + ': لا توجد مجموعات خيارات');
        return;
      }
      var seenGroups = {};
      p.groups.forEach(function (g) {
        if (!g || !g.id) { errors.push(tag + ': مجموعة بدون id'); return; }
        if (seenGroups[g.id]) errors.push(tag + ': مجموعة مكررة "' + g.id + '"');
        seenGroups[g.id] = true;

        if (g.type !== 'single' && g.type !== 'multi') {
          errors.push(tag + '/المجموعة "' + g.id + '": النوع يجب أن يكون single أو multi');
        }
        if (!Array.isArray(g.options) || g.options.length === 0) {
          errors.push(tag + '/المجموعة "' + g.id + '": لا توجد خيارات');
          return;
        }
        var seenOpts = {};
        var hasDefault = false;
        g.options.forEach(function (o) {
          if (!o || !o.id) { errors.push(tag + '/المجموعة "' + g.id + '": خيار بدون id'); return; }
          if (seenOpts[o.id]) errors.push(tag + '/المجموعة "' + g.id + '": خيار مكرر "' + o.id + '"');
          seenOpts[o.id] = true;
          if (o.delta !== undefined && (!isInt(o.delta))) {
            errors.push(tag + '/' + g.id + '/' + o.id + ': delta يجب أن يكون عددًا صحيحًا');
          }
          if (o.flat !== undefined && (!isInt(o.flat) || o.flat < 0)) {
            errors.push(tag + '/' + g.id + '/' + o.id + ': flat يجب أن يكون عددًا صحيحًا ≥ 0');
          }
          if (g.default === o.id) hasDefault = true;
        });
        if (g.required && g.type === 'single' && !hasDefault && g.default !== undefined) {
          errors.push(tag + '/المجموعة "' + g.id + '": القيمة الافتراضية default غير موجودة');
        }
      });
    });

    return errors;
  }

  /* ------------------------------------------------------------------ */
  /* الحساب الأساسي                                                      */
  /* ------------------------------------------------------------------ */

  function findById(list, id) {
    if (!Array.isArray(list)) return null;
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].id === id) return list[i];
    }
    return null;
  }

  /** اختيار الشريحة: آخر شريحة يكون minQty <= الكمية (الشرائح مرتبة تصاعديًا) */
  function pickTier(tiers, qty) {
    var chosen = null;
    for (var i = 0; i < tiers.length; i++) {
      if (tiers[i].minQty <= qty) chosen = tiers[i];
    }
    return chosen || tiers[0];
  }

  function normalizeSelections(product) {
    var sel = {};
    (product.groups || []).forEach(function (g) {
      if (g.type === 'multi') {
        sel[g.id] = Array.isArray(g.default) ? g.default.slice() : [];
      } else {
        sel[g.id] = g.default === undefined ? null : g.default;
      }
    });
    return sel;
  }

  /**
   * حساب عرض السعر الكامل.
   * @param {Object} catalog  كتالوج المنتجات والإعدادات
   * @param {Object} input    { productId, qty, selections, rush, delivery }
   * @returns {{ok:boolean, errors:string[], data:Object|null}}
   */
  function computeQuote(catalog, input) {
    var errors = [];
    if (!catalog || typeof catalog !== 'object') {
      return { ok: false, errors: ['الكتالوج غير صالح'], data: null };
    }
    input = input || {};
    var settings = catalog.settings || {};
    var currency = settings.currency || { code: 'SAR', symbol: 'ر.س', minorUnits: 2 };

    var product = findById(catalog.products, input.productId);
    if (!product) {
      return { ok: false, errors: ['المنتج المطلوب غير موجود في الكتالوج'], data: null };
    }

    /* ---- 0) التحقق من الكمية ---- */
    var qty = toInt(input.qty, null);
    var minQty = toInt(product.minQty, 1);
    var step = toInt(product.qtyStep, 0);
    var maxQty = toInt(settings.maxQty, 1000000);

    if (qty === null) {
      errors.push('أدخل كمية صحيحة');
    } else if (qty < 1) {
      errors.push('الكمية يجب أن تكون 1 على الأقل');
    } else if (qty < minQty) {
      errors.push('أقل كمية لهذا المنتج هي ' + minQty + ' ' + (product.unitLabel || 'قطعة'));
    } else if (step > 0 && (qty - minQty) % step !== 0) {
      errors.push('الكمية يجب أن تكون بمضاعفات ' + step + ' بدءًا من ' + minQty);
    } else if (qty > maxQty) {
      errors.push('الحد الأقصى للكمية في الطلب الواحد هو ' + maxQty.toLocaleString('en-US'));
    }

    /* ---- 1) سعر الوحدة = سعر الشريحة + دلتا الخيارات ---- */
    var tier = pickTier(product.tiers, qty === null ? minQty : qty);
    var perUnitBase = tier.unitPrice;
    var perUnitOptions = 0;
    var flats = 0;
    var selections = input.selections || normalizeSelections(product);
    var chosen = {};       // ما تم استخدامه فعليًا (يُعاد للعميل وللشيت)
    var perUnitLines = []; // تفصيل دلتا الوحدة
    var flatLines = [];    // تفصيل الرسوم الثابتة

    (product.groups || []).forEach(function (g) {
      if (g.type === 'multi') {
        var ids = selections[g.id];
        if (ids === undefined || ids === null) ids = [];
        if (!Array.isArray(ids)) ids = [ids];
        var picked = [];
        ids.forEach(function (id) {
          var o = findById(g.options, id);
          if (!o) { errors.push('خيار غير صالح في "' + (g.label || g.id) + '"'); return; }
          perUnitOptions += o.delta || 0;
          flats += o.flat || 0;
          picked.push(id);
          if (o.delta) perUnitLines.push({ group: g.label || g.id, option: o.label, amount: o.delta });
          if (o.flat) flatLines.push({ group: g.label || g.id, option: o.label, amount: o.flat });
        });
        chosen[g.id] = picked;
      } else {
        var sid = selections[g.id] === undefined ? g.default : selections[g.id];
        if (sid === null || sid === undefined || sid === '') {
          if (g.required) errors.push('يجب اختيار: ' + (g.label || g.id));
          chosen[g.id] = null;
          return;
        }
        var so = findById(g.options, sid);
        if (!so) {
          errors.push('خيار غير صالح في "' + (g.label || g.id) + '"');
          chosen[g.id] = null;
          return;
        }
        perUnitOptions += so.delta || 0;
        flats += so.flat || 0;
        chosen[g.id] = sid;
        if (so.delta) perUnitLines.push({ group: g.label || g.id, option: so.label, amount: so.delta });
        if (so.flat) flatLines.push({ group: g.label || g.id, option: so.label, amount: so.flat });
      }
    });

    if (errors.length) {
      return { ok: false, errors: errors, data: null };
    }

    /* ---- 2..8) ترتيب العمليات الثابت ---- */
    var perUnit = perUnitBase + perUnitOptions;
    var production = perUnit * qty;
    var flatsTotal = flats + (product.setupFee || 0);

    var rush = 0;
    if (input.rush) {
      rush = applyBpsRoundHalfUp(production + flatsTotal, settings.rushPctBps);
      if (rush === null) return { ok: false, errors: ['المبلغ يتجاوز الحد المدعوم'], data: null };
    }

    var delivery = 0;
    if (input.delivery) {
      delivery = (production + flatsTotal) >= settings.freeDeliveryThreshold ? 0 : settings.deliveryFee;
    }

    var taxable = production + flatsTotal + rush + delivery;
    var tax = applyBpsRoundHalfUp(taxable, settings.taxBps);
    if (tax === null) return { ok: false, errors: ['المبلغ يتجاوز الحد المدعوم'], data: null };
    var total = taxable + tax;

    // سلامة نهائية: أي نتيجة غير صحيحة => رفض صريح بدل تسجيل رقم خاطئ
    [perUnit, production, flatsTotal, rush, delivery, taxable, tax, total].forEach(function (v) {
      if (!isInt(v)) errors.push('نتيجة حسابية غير صالحة — تم إيقاف العملية');
    });
    if (errors.length) return { ok: false, errors: errors, data: null };

    var lines = [];
    lines.push({ code: 'unit_base', label: 'سعر الوحدة الأساسي (شريحة ' + tier.minQty + '+ ' + (product.unitLabel || 'قطعة') + ')', amount: perUnitBase, kind: 'perUnit' });
    perUnitLines.forEach(function (l) {
      lines.push({ code: 'unit_opt', label: l.group + ' — ' + l.option, amount: l.amount, kind: 'perUnit' });
    });
    if (product.setupFee) {
      lines.push({ code: 'setup', label: 'رسوم تجهيز أساسية', amount: product.setupFee, kind: 'flat' });
    }
    flatLines.forEach(function (l) {
      lines.push({ code: 'flat', label: 'رسوم ثابتة (مرة واحدة) — ' + l.group + ': ' + l.option, amount: l.amount, kind: 'flat' });
    });
    if (rush) lines.push({ code: 'rush', label: settings.rushLabel || 'رسوم إنتاج عاجل', amount: rush, kind: 'fee' });
    if (input.delivery) {
      lines.push({
        code: 'delivery',
        label: (settings.deliveryLabel || 'رسوم التوصيل') + (delivery === 0 ? ' (مجاني — الطلب فوق ' + formatMoney(settings.freeDeliveryThreshold, currency) + ')' : ''),
        amount: delivery,
        kind: 'fee'
      });
    }
    lines.push({ code: 'tax', label: settings.taxLabel || 'الضريبة', amount: tax, kind: 'tax' });

    var payloadForHash = {
      v: PRICING_VERSION,
      p: product.id,
      q: qty,
      s: chosen,
      r: !!input.rush,
      d: !!input.delivery,
      u: perUnit,
      t: total
    };

    return {
      ok: true,
      errors: [],
      data: {
        pricingVersion: PRICING_VERSION,
        currency: currency,
        productId: product.id,
        productName: product.name,
        unitLabel: product.unitLabel || 'قطعة',
        qty: qty,
        selections: chosen,
        tier: { minQty: tier.minQty, unitPrice: tier.unitPrice },
        perUnitBase: perUnitBase,
        perUnitOptions: perUnitOptions,
        perUnit: perUnit,
        production: production,
        setupFee: product.setupFee || 0,
        flats: flatsTotal,
        rush: rush,
        delivery: delivery,
        taxable: taxable,
        tax: tax,
        total: total,
        taxBps: settings.taxBps,
        rushPctBps: settings.rushPctBps,
        lines: lines,
        leadTimeDays: input.rush ? (settings.leadTimeRushDays || settings.leadTimeDays) : settings.leadTimeDays,
        calcHash: calcHash(payloadForHash)
      }
    };
  }

  /* ------------------------------------------------------------------ */

  return {
    PRICING_VERSION: PRICING_VERSION,
    ORDER_OF_OPERATIONS: ORDER_OF_OPERATIONS,
    BPS: BPS,
    applyBpsRoundHalfUp: applyBpsRoundHalfUp,
    formatMoney: formatMoney,
    validateCatalog: validateCatalog,
    computeQuote: computeQuote,
    pickTier: pickTier,
    normalizeSelections: normalizeSelections,
    calcHash: calcHash
  };
})();

if (typeof module !== 'undefined' && module.exports) { module.exports = VANTA_PRICING; }
