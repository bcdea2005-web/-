#!/usr/bin/env node
/**
 * VANTA — أداة البناء
 * ------------------------------------------------------------------
 * تنسخ "محرك التسعير" و"الكتالوج" من مصدر واحد إلى:
 *   - assets/vanta-pricing.js   (يستخدمه الموقع)
 *   - assets/vanta-catalog.js   (يستخدمه الموقع)
 *   - google-apps-script/Pricing.gs
 *   - google-apps-script/Catalog.gs
 *
 * الهدف: يستحيل أن يختلف حساب الموقع عن حساب Google Apps Script،
 * لأنهما حرفيًا نفس الكود ونفس البيانات.
 *
 * التشغيل: node tools/build.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const write = (p, content) => {
  const full = path.join(ROOT, p);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
  console.log('  ✓ ' + p + '  (' + content.length.toLocaleString('en-US') + ' حرف)');
};

// تحميل محرك التسعير في بيئة Node بدون تعديل الملف
function loadPricing() {
  const src = read('src/pricing-core.js');
  return new Function(src + '\nreturn VANTA_PRICING;')();
}

console.log('\n VANTA — بناء الملفات المشتركة \n');

const pricing = loadPricing();
const catalogText = read('catalog.json');
let catalog;
try {
  catalog = JSON.parse(catalogText);
} catch (e) {
  console.error('✗ catalog.json يحتوي خطأ JSON: ' + e.message);
  process.exit(1);
}

// 1) التحقق من سلامة الكتالوج قبل أي توليد
const catalogErrors = pricing.validateCatalog(catalog);
if (catalogErrors.length) {
  console.error('✗ الكتالوج غير صالح:');
  catalogErrors.forEach((e) => console.error('   - ' + e));
  process.exit(1);
}
console.log('  ✓ الكتالوج سليم (' + catalog.products.length + ' منتجات، ' +
  catalog.products.reduce((n, p) => n + p.tiers.length, 0) + ' شرائح أسعار)\n');

// 2) توليد الملفات
const catalogJsonPretty = JSON.stringify(catalog, null, 2);
const pricingSrc = read('src/pricing-core.js');

write('assets/vanta-pricing.js',
  '/* ملف مولّد آليًا من src/pricing-core.js — لا تعدّله يدويًا */\n' + pricingSrc);
write('assets/vanta-catalog.js',
  '/* ملف مولّد آليًا من catalog.json — لا تعدّله يدويًا */\nwindow.VANTA_CATALOG = ' + catalogJsonPretty + ';\n');
write('google-apps-script/Pricing.gs',
  '/* ملف مولّد آليًا من src/pricing-core.js — لا تعدّله يدويًا */\n' + pricingSrc);
write('google-apps-script/Catalog.gs',
  '/* ملف مولّد آليًا من catalog.json — لا تعدّله يدويًا */\nvar CATALOG = ' + catalogJsonPretty + ';\n');

console.log('\n تم بناء كل الملفات بنجاح.\n');
