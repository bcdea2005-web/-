/**
 * VANTA — اختبارات محرك التسعير
 * ------------------------------------------------------------------
 * التشغيل: node --test tests/pricing.test.mjs
 *
 * تشمل:
 *   - التحقق من سلامة الكتالوج (لا بيانات تسبب حسابًا خاطئًا)
 *   - حالات محسوبة باليد (أرقام ثابتة)
 *   - حدود الشرائح (tier boundaries)
 *   - التقريب نصف للأعلى
 *   - اختبار عشوائي: 3000 طلب تُقارَن بتطبيق مرجعي مستقل بحساب BigInt
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(ROOT, 'src/pricing-core.js'), 'utf8');
const P = new Function(src + '\nreturn VANTA_PRICING;')();
const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog.json'), 'utf8'));
const S = (catalog.settings || {});

/* ------------------------------------------------------------------ */
/* 1) سلامة الكتالوج                                                    */
/* ------------------------------------------------------------------ */

test('الكتالوج خالٍ من أي خطأ في البيانات', () => {
  const errors = P.validateCatalog(catalog);
  assert.deepEqual(errors, [], 'أخطاء الكتالوج:\n' + errors.join('\n'));
});

test('رفض كتالوج فاسد (شريحة سعر غير صحيحة)', () => {
  const bad = JSON.parse(JSON.stringify(catalog));
  bad.products[0].tiers[0].unitPrice = 1.5; // رقم عشري ممنوع
  const errors = P.validateCatalog(bad);
  assert.ok(errors.length > 0, 'يجب رفض السعر العشري');
});

test('رفض كتالوج فاسد (شرائح غير مرتبة)', () => {
  const bad = JSON.parse(JSON.stringify(catalog));
  bad.products[0].tiers.reverse();
  const errors = P.validateCatalog(bad);
  assert.ok(errors.some((e) => e.includes('غير مرتبة')), 'يجب كشف الشرائح غير المرتبة');
});

/* ------------------------------------------------------------------ */
/* 2) التقريب                                                            */
/* ------------------------------------------------------------------ */

test('التقريب نصف للأعلى (Half-Up) — حالات حدية', () => {
  // 100 * 1500 / 10000 = 15 بالضبط
  assert.equal(P.applyBpsRoundHalfUp(100, 1500), 15);
  // 1 * 5000 / 10000 = 0.5 => 1
  assert.equal(P.applyBpsRoundHalfUp(1, 5000), 1);
  // 1 * 4999 / 10000 = 0.4999 => 0
  assert.equal(P.applyBpsRoundHalfUp(1, 4999), 0);
  // 3 * 1667 / 10000 = 0.5001 => 1
  assert.equal(P.applyBpsRoundHalfUp(3, 1667), 1);
  // 999 * 15 / 10000 = 1.4985 => 1
  assert.equal(P.applyBpsRoundHalfUp(999, 15), 1);
  // 0
  assert.equal(P.applyBpsRoundHalfUp(0, 1500), 0);
});

test('التقريب صحيح على أرقام ضخمة (بلا خطأ فاصلة عائمة)', () => {
  // مبلغ خارج النطاق الآمن للأعداد الصحيحة => يُرفض صراحةً ولا يُقصّ بصمت
  assert.equal(P.applyBpsRoundHalfUp(1e20, 1500), null);
  // مدخل غير صحيح => null
  assert.equal(P.applyBpsRoundHalfUp(1.5, 1500), null);
  assert.equal(P.applyBpsRoundHalfUp(100, 1.5), null);
  // داخل النطاق الآمن: مقارنة مع حساب BigInt مستقل
  const amount = 987654321; // 9,876,543.21
  const expected = Number((BigInt(amount) * BigInt(1500) + BigInt(5000)) / BigInt(10000));
  assert.equal(P.applyBpsRoundHalfUp(amount, 1500), expected);
});

/* ------------------------------------------------------------------ */
/* 3) شرائح الكمية                                                       */
/* ------------------------------------------------------------------ */

test('اختيار الشريحة الصحيحة عند الحدود', () => {
  const p = catalog.products.find((x) => x.id === 'paper-bag'); // 100/500/1000/5000
  const sel = P.normalizeSelections(p);
  const cases = [
    [100, 320], [150, 320], [450, 320],
    [500, 275], [950, 275],
    [1000, 235], [4950, 235],
    [5000, 195], [10000, 195]
  ];
  for (const [qty, expectedBase] of cases) {
    const r = P.computeQuote(catalog, { productId: 'paper-bag', qty, selections: sel });
    assert.equal(r.ok, true, 'qty=' + qty + ' => ' + r.errors.join(','));
    assert.equal(r.data.perUnitBase, expectedBase, 'سعر الشريحة خاطئ عند qty=' + qty);
    assert.equal(r.data.tier.minQty, [100, 500, 1000, 5000].filter((m) => m <= qty).pop());
  }
});

test('رفض كمية أقل من الحد الأدنى وخارج مضاعفات الخطوة', () => {
  const p = catalog.products.find((x) => x.id === 'paper-bag');
  const sel = P.normalizeSelections(p);
  assert.equal(P.computeQuote(catalog, { productId: 'paper-bag', qty: 99, selections: sel }).ok, false);
  assert.equal(P.computeQuote(catalog, { productId: 'paper-bag', qty: 100, selections: sel }).ok, true);
  assert.equal(P.computeQuote(catalog, { productId: 'paper-bag', qty: 101, selections: sel }).ok, false);
  assert.equal(P.computeQuote(catalog, { productId: 'paper-bag', qty: 150, selections: sel }).ok, true);
  assert.equal(P.computeQuote(catalog, { productId: 'paper-bag', qty: 0, selections: sel }).ok, false);
  assert.equal(P.computeQuote(catalog, { productId: 'paper-bag', qty: -5, selections: sel }).ok, false);
  assert.equal(P.computeQuote(catalog, { productId: 'paper-bag', qty: 'abc', selections: sel }).ok, false);
  assert.equal(P.computeQuote(catalog, { productId: 'paper-bag', qty: 1.7, selections: sel }).ok, false);
});

test('رفض منتج أو خيار غير موجود', () => {
  const p = catalog.products.find((x) => x.id === 'paper-bag');
  const sel = P.normalizeSelections(p);
  assert.equal(P.computeQuote(catalog, { productId: 'does-not-exist', qty: 100, selections: sel }).ok, false);
  const badSel = Object.assign({}, sel, { size: 'XXL' });
  assert.equal(P.computeQuote(catalog, { productId: 'paper-bag', qty: 100, selections: badSel }).ok, false);
  const noSel = Object.assign({}, sel, { material: null });
  assert.equal(P.computeQuote(catalog, { productId: 'paper-bag', qty: 100, selections: noSel }).ok, false);
});

/* ------------------------------------------------------------------ */
/* 4) حالة محسوبة باليد                                                 */
/* ------------------------------------------------------------------ */
/* المثال: كيس ورقي، كمية 500، وسط (25)، كرافت (0)، لونان وجه واحد (30 + flat 25000)،
   حبل قطني (40)، بدون تشطيب (0)، بدون إضافات، بدون استعجال، مع توصيل.
   perUnit   = 275 (شريحة 500) + 25 + 0 + 30 + 40 + 0 = 370 هللة = 3.70
   production= 370 × 500 = 185,000
   flats     = 25,000
   rush      = 0
   taxable_pre = 210,000
   delivery  = 185,000 + 25,000 = 210,000 < 300,000 => 25,000
   taxable   = 210,000 + 25,000 = 235,000
   tax       = round(235,000 × 1500/10000) = 35,250
   total     = 270,250 هللة = 2,702.50
*/
test('حالة مرجعية محسوبة يدويًا بالكامل', () => {
  const p = catalog.products.find((x) => x.id === 'paper-bag');
  const sel = P.normalizeSelections(p);
  sel.size = 'm';
  sel.material = 'kraft120';
  sel.print = '2c1s';
  sel.handle = 'cotton';
  sel.finish = 'none';
  sel.extras = [];

  const r = P.computeQuote(catalog, { productId: 'paper-bag', qty: 500, selections: sel, delivery: true });
  assert.equal(r.ok, true, r.errors.join(','));
  assert.equal(r.data.perUnit, 370);
  assert.equal(r.data.production, 185000);
  assert.equal(r.data.flats, 25000);
  assert.equal(r.data.rush, 0);
  assert.equal(r.data.delivery, 25000);
  assert.equal(r.data.taxable, 235000);
  assert.equal(r.data.tax, 35250);
  assert.equal(r.data.total, 270250);
  assert.equal(P.formatMoney(r.data.total, r.data.currency), '2,702.50 ر.س');
});

test('الاستعجال 15% يُحسب على (الإنتاج + الرسوم الثابتة) قبل التوصيل والضريبة', () => {
  const p = catalog.products.find((x) => x.id === 'paper-bag');
  const sel = P.normalizeSelections(p);
  sel.print = 'cmyk2s'; // flat = 0
  const r = P.computeQuote(catalog, { productId: 'paper-bag', qty: 500, selections: sel, rush: true, delivery: true });
  // perUnit = 275 + 25(m) + 0 + 95(cmyk) + 40(cotton) + 0 = 435
  // production = 217,500 ; flats = 0
  // rush = round(217500 * 0.15) = 32,625
  assert.equal(r.data.perUnit, 435);
  assert.equal(r.data.production, 217500);
  assert.equal(r.data.rush, 32625);
  // delivery: 217,500 < 300,000 => 25,000
  assert.equal(r.data.delivery, 25000);
  // taxable = 217500 + 0 + 32625 + 25000 = 275,125 ; tax = round(275125*.15)= 41,268.75 => 41,269
  assert.equal(r.data.taxable, 275125);
  assert.equal(r.data.tax, 41269);
  assert.equal(r.data.total, 316394);
});

test('توصيل مجاني عند تجاوز الحد، وبدون رسوم إن لم يُطلب توصيل', () => {
  const p = catalog.products.find((x) => x.id === 'cotton-tote');
  const sel = P.normalizeSelections(p);
  const r1 = P.computeQuote(catalog, { productId: 'cotton-tote', qty: 500, selections: sel, delivery: true });
  assert.ok(r1.data.production + r1.data.flats >= S.freeDeliveryThreshold);
  assert.equal(r1.data.delivery, 0);

  const r2 = P.computeQuote(catalog, { productId: 'cotton-tote', qty: 500, selections: sel, delivery: false });
  assert.equal(r2.data.delivery, 0);
  assert.equal(r2.data.total, r1.data.total, 'التوصيل المجاني لا يغيّر الإجمالي');
});

test('الإضافات متعددة الاختيار تُجمع بشكل صحيح', () => {
  const p = catalog.products.find((x) => x.id === 'nonwoven-bag');
  const sel = P.normalizeSelections(p);
  const base = P.computeQuote(catalog, { productId: 'nonwoven-bag', qty: 1000, selections: sel });
  const withExtras = P.computeQuote(catalog, {
    productId: 'nonwoven-bag', qty: 1000,
    selections: Object.assign({}, sel, { extras: ['pocket', 'zipper'] })
  });
  // delta = 45 (جيب) + 85 (سحّاب) = 130 للوحدة
  assert.equal(withExtras.data.perUnit - base.data.perUnit, 130);
  assert.equal(withExtras.data.production - base.data.production, 130 * 1000);
});

/* ------------------------------------------------------------------ */
/* 5) اختبار عشوائي مقابل تطبيق مرجعي مستقل (BigInt)                     */
/* ------------------------------------------------------------------ */

function referenceCompute(catalog, productId, qty, selections, rush, delivery) {
  // تطبيق مرجعي مستقل تمامًا عن كود المحرك، بحساب BigInt
  const product = catalog.products.find((p) => p.id === productId);
  const st = catalog.settings;
  let tierPrice = product.tiers[0].unitPrice;
  for (const t of product.tiers) if (BigInt(t.minQty) <= BigInt(qty)) tierPrice = t.unitPrice;
  let perUnit = BigInt(tierPrice);
  let flats = BigInt(product.setupFee || 0);
  for (const g of product.groups) {
    if (g.type === 'multi') {
      for (const id of selections[g.id] || []) {
        const o = g.options.find((x) => x.id === id);
        perUnit += BigInt(o.delta || 0);
        flats += BigInt(o.flat || 0);
      }
    } else {
      const id = selections[g.id];
      const o = g.options.find((x) => x.id === id);
      perUnit += BigInt(o.delta || 0);
      flats += BigInt(o.flat || 0);
    }
  }
  const production = perUnit * BigInt(qty);
  const beforeFees = production + flats;
  let rushAmt = BigInt(0);
  if (rush) rushAmt = (beforeFees * BigInt(st.rushPctBps) + BigInt(5000)) / BigInt(10000);
  let deliveryAmt = BigInt(0);
  if (delivery) deliveryAmt = beforeFees >= BigInt(st.freeDeliveryThreshold) ? BigInt(0) : BigInt(st.deliveryFee);
  const taxable = beforeFees + rushAmt + deliveryAmt;
  const tax = (taxable * BigInt(st.taxBps) + BigInt(5000)) / BigInt(10000);
  const total = taxable + tax;
  return {
    perUnit: perUnit.toString(),
    production: production.toString(),
    flats: flats.toString(),
    rush: rushAmt.toString(),
    delivery: deliveryAmt.toString(),
    taxable: taxable.toString(),
    tax: tax.toString(),
    total: total.toString()
  };
}

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('3000 سيناريو عشوائي: حساب المحرك = الحساب المرجعي المستقل (BigInt)', () => {
  const rnd = mulberry32(20261002);
  let checked = 0;
  for (let i = 0; i < 3000; i++) {
    const product = catalog.products[Math.floor(rnd() * catalog.products.length)];
    const sel = P.normalizeSelections(product);
    for (const g of product.groups) {
      if (g.type === 'multi') {
        const picks = [];
        for (const o of g.options) if (rnd() < 0.25) picks.push(o.id);
        sel[g.id] = picks;
      } else {
        sel[g.id] = g.options[Math.floor(rnd() * g.options.length)].id;
      }
    }
    // كمية عشوائية تحترم الحد الأدنى والخطوة
    const step = product.qtyStep || 1;
    const stepsAhead = Math.floor(rnd() * 400);
    const qty = product.minQty + stepsAhead * step;
    const rush = rnd() < 0.3;
    const delivery = rnd() < 0.7;

    const got = P.computeQuote(catalog, { productId: product.id, qty, selections: sel, rush, delivery });
    assert.equal(got.ok, true, 'فشل غير متوقع: ' + got.errors.join(','));
    const exp = referenceCompute(catalog, product.id, qty, sel, rush, delivery);
    assert.equal(String(got.data.perUnit), exp.perUnit, 'perUnit منتج ' + product.id);
    assert.equal(String(got.data.production), exp.production);
    assert.equal(String(got.data.flats), exp.flats);
    assert.equal(String(got.data.rush), exp.rush);
    assert.equal(String(got.data.delivery), exp.delivery);
    assert.equal(String(got.data.taxable), exp.taxable);
    assert.equal(String(got.data.tax), exp.tax);
    assert.equal(String(got.data.total), exp.total, 'الإجمالي منتج=' + product.id + ' qty=' + qty);
    checked++;
  }
  assert.equal(checked, 3000);
});

test('الإجمالي دائمًا = مجموع بنود التفصيل (كل منتج × كل كمية حدية)', () => {
  for (const product of catalog.products) {
    const sel = P.normalizeSelections(product);
    const step = product.qtyStep || 1;
    const qtys = [product.minQty, product.minQty + step, ...product.tiers.map((t) => t.minQty),
      ...product.tiers.map((t) => t.minQty - 1), ...product.tiers.map((t) => t.minQty + step)];
    for (const qty of qtys) {
      if (qty < product.minQty || (step > 0 && (qty - product.minQty) % step !== 0)) continue;
      const r = P.computeQuote(catalog, { productId: product.id, qty, selections: sel, rush: true, delivery: true });
      if (!r.ok) continue;
      const d = r.data;
      // تحقق داخلي: taxable + tax = total، و production = perUnit × qty
      assert.equal(d.production, d.perUnit * d.qty, 'production خاطئ ' + product.id);
      assert.equal(d.taxable, d.production + d.flats + d.rush + d.delivery, 'taxable خاطئ ' + product.id);
      assert.equal(d.total, d.taxable + d.tax, 'total خاطئ ' + product.id);
      assert.ok(Number.isSafeInteger(d.total) && d.total >= 0, 'إجمالي غير صالح ' + product.id);
      // الوحدة = الأساس + الخيارات
      assert.equal(d.perUnit, d.perUnitBase + d.perUnitOptions, 'perUnit خاطئ ' + product.id);
    }
  }
});

test('الأسعار تنخفض مع زيادة الكمية (منطق شرائح سليم)', () => {
  for (const product of catalog.products) {
    for (let i = 1; i < product.tiers.length; i++) {
      assert.ok(product.tiers[i].unitPrice <= product.tiers[i - 1].unitPrice,
        'سعر الشريحة الأعلى أغلى في المنتج ' + product.id);
    }
  }
});

/* ------------------------------------------------------------------ */
/* 6) التنسيق والبصمة                                                    */
/* ------------------------------------------------------------------ */

test('تنسيق المبالغ صحيح', () => {
  const c = { symbol: 'ر.س', minorUnits: 2 };
  assert.equal(P.formatMoney(0, c), '0.00 ر.س');
  assert.equal(P.formatMoney(5, c), '0.05 ر.س');
  assert.equal(P.formatMoney(50, c), '0.50 ر.س');
  assert.equal(P.formatMoney(100, c), '1.00 ر.س');
  assert.equal(P.formatMoney(1234567, c), '12,345.67 ر.س');
  assert.equal(P.formatMoney(100000000, c), '1,000,000.00 ر.س');
});

test('بصمة الحساب ثابتة لنفس المدخلات ومختلفة لغيرها', () => {
  const p = catalog.products[0];
  const sel = P.normalizeSelections(p);
  const a = P.computeQuote(catalog, { productId: p.id, qty: 100, selections: sel });
  const b = P.computeQuote(catalog, { productId: p.id, qty: 100, selections: sel });
  const c = P.computeQuote(catalog, { productId: p.id, qty: 150, selections: sel });
  assert.equal(a.data.calcHash, b.data.calcHash);
  assert.notEqual(a.data.calcHash, c.data.calcHash);
  assert.match(a.data.calcHash, /^[0-9a-f]{8}$/);
});
