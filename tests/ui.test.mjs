/**
 * VANTA — اختبار الواجهة (DOM)
 * ------------------------------------------------------------------
 * يشغّل index.html داخل بيئة DOM حقيقية (jsdom) ويتحقق من:
 *   - تحميل الكتالوج والمحرك بدون أخطاء
 *   - رسم كل المنتجات والمواصفات
 *   - تحديث الإجمالي عند تغيير الكمية والخيارات
 *   - سلوك الأزرار ونموذج العميل (تحقق + إرسال)
 *
 * التشغيل: node --test tests/ui.test.mjs
 * (إن لم تكن jsdom مثبتة: npm install --no-save jsdom)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let JSDOM, VirtualConsole;
try {
  ({ JSDOM, VirtualConsole } = await import('jsdom'));
} catch (e) {
  console.log('\n⚠ jsdom غير مثبتة — تم تخطي اختبارات الواجهة. ثبّتها بـ: npm install --no-save jsdom\n');
}

function buildPage() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')
    // إزالة كل الوسوم الخارجية والأسكربتات (سنحقنها يدويًا بدون شبكة)
    .replace(/<link[^>]*fonts\.(googleapis|gstatic)[^>]*>/g, '')
    .replace(/<script src="assets\/[^"]+"><\/script>/g, '');

  const errors = [];
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://vanta.test/index.html',
    virtualConsole: new VirtualConsole().on('jsdomError', (e) => errors.push(e.message))
  });

  const { window } = dom;
  window.scrollTo = () => {};
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.navigator.clipboard = { writeText: async () => {} };
  window.open = () => null;
  // نمنع أي محاولة fetch (الوضع التجريبي لا يحتاجه)
  window.fetch = () => Promise.reject(new Error('no network in test'));

  ['assets/config.js', 'assets/vanta-catalog.js', 'assets/vanta-pricing.js', 'assets/app.js'].forEach((f) => {
    window.eval(fs.readFileSync(path.join(ROOT, f), 'utf8'));
  });

  // في jsdom يبقى readyState = loading بعد الحقن، لذا نُطلق الحدث يدويًا
  // (في المتصفح الحقيقي يُطلق تلقائيًا بعد تنفيذ الأسكربتات)
  if (window.document.readyState === 'loading') {
    window.document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));
  }

  return { window, doc: window.document, errors };
}

const MONEY = /^[\d,]+\.\d{2} ر\.س$/;

test('تحميل الصفحة كاملة بدون أي خطأ تنفيذي', () => {
  const { window, doc, errors } = buildPage();
  assert.deepEqual(errors, [], 'أخطاء تنفيذية: ' + errors.join(' | '));
  assert.equal(doc.querySelectorAll('#productsGrid .product-card').length, window.VANTA_CATALOG.products.length);
  assert.equal(doc.querySelectorAll('#productPicker .pick').length, window.VANTA_CATALOG.products.length);
  assert.ok(doc.getElementById('groupsBox').children.length > 0, 'لم تُرسم مجموعات المواصفات');
  assert.match(doc.getElementById('totalValue').textContent, MONEY, 'الإجمالي الأولي غير معروض');
});

test('الإجمالي يتغيّر فورًا عند تغيير الكمية ويطابق المحرك', () => {
  const { window, doc } = buildPage();
  const P = window.VANTA_PRICING, C = window.VANTA_CATALOG;
  const qty = doc.getElementById('qty');

  function totalFor(n) {
    qty.value = String(n);
    qty.dispatchEvent(new window.Event('input', { bubbles: true }));
    const shown = doc.getElementById('totalValue').textContent;
    const r = P.computeQuote(C, {
      productId: C.products[0].id,
      qty: n,
      selections: P.normalizeSelections(C.products[0]),
      rush: false, delivery: true
    });
    assert.equal(r.ok, true, 'qty=' + n + ' => ' + r.errors.join(','));
    assert.equal(shown, P.formatMoney(r.data.total, r.data.currency), 'الإجمالي المعروض لا يطابق المحرك عند qty=' + n);
  }
  [100, 150, 500, 1000, 5000].forEach(totalFor);
});

test('كمية غير صالحة تُظهر رسالة خطأ ولا توقف الصفحة', () => {
  const { doc, window } = buildPage();
  const qty = doc.getElementById('qty');
  qty.value = '10'; // أقل من الحد الأدنى (100)
  qty.dispatchEvent(new window.Event('input', { bubbles: true }));
  const err = doc.getElementById('errBox');
  assert.equal(err.classList.contains('show'), true, 'يجب إظهار تنبيه الخطأ');
  assert.ok(err.textContent.includes('أقل كمية'), 'نص الخطأ: ' + err.textContent);
  assert.equal(doc.getElementById('submitBtn').disabled, true, 'يجب تعطيل زر الإرسال');
});

test('تبديل المنتج يعيد رسم المواصفات والكمية الأدنى', () => {
  const { window, doc } = buildPage();
  const picks = doc.querySelectorAll('#productPicker .pick');
  const idx = window.VANTA_CATALOG.products.findIndex((p) => p.id === 'cotton-tote');
  picks[idx].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(doc.getElementById('qty').value, '50', 'أقل كمية لحقيبة قطنية = 50');
  assert.equal(doc.getElementById('errBox').classList.contains('show'), false);
  assert.match(doc.getElementById('totalValue').textContent, MONEY);
});

test('اختيار خيار يزيد سعر الوحدة والكمية الإجمالية', () => {
  const { window, doc } = buildPage();
  const before = doc.getElementById('totalValue').textContent;
  const groups = doc.querySelectorAll('#groupsBox .group');
  // أول مجموعة = المقاس: اختر أكبر مقاس (آخر خيار)
  const sizeOpts = groups[0].querySelectorAll('.opt');
  sizeOpts[sizeOpts.length - 1].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const after = doc.getElementById('totalValue').textContent;
  assert.notEqual(before, after, 'الإجمالي يجب أن يرتفع مع مقاس أكبر');
});

test('مسار طلب كامل: تعبئة النموذج + إرسال + إيصال', () => {
  const { window, doc } = buildPage();

  // تحقق من رفض الاسم القصير والجوال الخاطئ
  doc.getElementById('cName').value = 'أ';
  doc.getElementById('cPhone').value = '123';
  doc.getElementById('submitBtn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.ok(doc.getElementById('f-name').classList.contains('invalid'), 'يجب رفض الاسم القصير');
  assert.ok(doc.getElementById('f-phone').classList.contains('invalid'), 'يجب رفض الجوال الخاطئ');
  assert.equal(doc.getElementById('receipt').classList.contains('show'), false, 'لا إيصال قبل صحة البيانات');

  // بيانات صحيحة
  doc.getElementById('cName').value = 'محمد أحمد';
  doc.getElementById('cCompany').value = 'شركة الاختبار';
  doc.getElementById('cPhone').value = '0551234567';
  doc.getElementById('cEmail').value = 'test@example.com';
  doc.getElementById('cCity').value = 'الرياض';
  doc.getElementById('cNotes').value = 'نريد الشعار بالذهبي';
  doc.getElementById('submitBtn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  const receipt = doc.getElementById('receipt');
  assert.equal(receipt.classList.contains('show'), true, 'يجب عرض الإيصال');
  assert.match(receipt.textContent, /DEMO-\d{8}-\d{4}/, 'رقم الطلب التجريبي: ' + receipt.querySelector('.no').textContent);
  assert.ok(receipt.textContent.includes('الإجمالي المعتمد'));
});

test('الإجمالي المعروض في الإيصال يطابق حساب المحرك', () => {
  const { window, doc } = buildPage();
  const P = window.VANTA_PRICING, C = window.VANTA_CATALOG;
  doc.getElementById('cName').value = 'محمد أحمد';
  doc.getElementById('cPhone').value = '0551234567';
  doc.getElementById('submitBtn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  const r = P.computeQuote(C, {
    productId: C.products[0].id, qty: C.products[0].minQty,
    selections: P.normalizeSelections(C.products[0]),
    rush: false, delivery: true
  });
  const receiptText = doc.getElementById('receipt').textContent;
  assert.ok(receiptText.includes(P.formatMoney(r.data.total, r.data.currency)),
    'الإيصال لا يحتوي الإجمالي الصحيح ' + P.formatMoney(r.data.total, r.data.currency) + '\n' + receiptText);
});

test('كل منتج يُرسم ويُحسب بنجاح عند اختياره', () => {
  const { window, doc } = buildPage();
  const C = window.VANTA_CATALOG, P = window.VANTA_PRICING;
  C.products.forEach((p, i) => {
    doc.querySelectorAll('#productPicker .pick')[i].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    const shown = doc.getElementById('totalValue').textContent;
    assert.match(shown, MONEY, 'منتج ' + p.id);
    const r = P.computeQuote(C, {
      productId: p.id, qty: p.minQty, selections: P.normalizeSelections(p), rush: true, delivery: true
    });
    assert.equal(r.ok, true, p.id + ': ' + r.errors.join(','));
  });
});
