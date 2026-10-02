/* ==================================================================
   VANTA — منطق الموقع ونموذج الطلب
   ------------------------------------------------------------------
   لا يحتوي هذا الملف على أي عملية حسابية: كل الأرقام تأتي من
   VANTA_PRICING.computeQuote (نفس المحرك المستخدم في Google Apps Script).
   مهمة هذا الملف: الواجهة + التحقق + الإرسال فقط.
   ================================================================== */
(function () {
  'use strict';

  var CFG = window.VANTA_CONFIG || {};
  var CATALOG = window.VANTA_CATALOG;
  var P = window.VANTA_PRICING;
  var CURRENCY = (CATALOG && CATALOG.settings && CATALOG.settings.currency) || CFG.currency;
  var SETTINGS = (CATALOG && CATALOG.settings) || {};

  var money = function (minor) { return P.formatMoney(minor, CURRENCY); };

  /* ---------------- حالة الطلب ---------------- */
  var state = {
    productId: (CATALOG && CATALOG.products[0]) ? CATALOG.products[0].id : null,
    qty: 100,
    selections: {},
    rush: false,
    delivery: true,
    submitting: false
  };

  var $ = function (id) { return document.getElementById(id); };
  var el = function (tag, cls, txt) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt !== undefined) n.textContent = txt;
    return n;
  };

  function getProduct() {
    for (var i = 0; i < CATALOG.products.length; i++) {
      if (CATALOG.products[i].id === state.productId) return CATALOG.products[i];
    }
    return CATALOG.products[0];
  }

  function fmtQty(n) { return Number(n).toLocaleString('en-US'); }

  /* ==================================================================
     1) تعبئة بيانات الشركة في كل مكان
     ================================================================== */
  function renderCompanyInfo() {
    var c = CFG.company || {};
    document.title = (c.name || 'فانتا VANTA') + ' | طباعة الأكياس والحقائب الدعائية للشركات';

    var topbar = $('topbarContact');
    if (topbar) {
      topbar.innerHTML = '📞 <a dir="ltr" href="tel:' + (c.phone || '').replace(/\s/g, '') + '">' + (c.phone || '') + '</a>' +
        ' &nbsp;·&nbsp; ✉️ <a href="mailto:' + (c.email || '') + '">' + (c.email || '') + '</a>';
    }

    var list = $('contactList');
    if (list) {
      var items = [
        ['📞', 'الهاتف', c.phone, 'tel:' + (c.phone || '').replace(/\s/g, '')],
        ['✉️', 'البريد الإلكتروني', c.email, 'mailto:' + (c.email || '')],
        ['📍', 'العنوان', c.address, ''],
        ['🕘', 'ساعات العمل', c.hours, '']
      ];
      list.innerHTML = '';
      items.forEach(function (it) {
        var li = el('li');
        li.appendChild(el('span', 'ic', it[0]));
        var box = el('div');
        box.appendChild(el('b', null, it[1]));
        var val = el('span', null, it[2] || '');
        if (it[3]) { val.innerHTML = '<a href="' + it[3] + '">' + it[2] + '</a>'; }
        box.appendChild(val);
        li.appendChild(box);
        list.appendChild(li);
      });
    }

    var fc = $('footerContact');
    if (fc) {
      fc.innerHTML = '';
      [['📞 ' + (c.phone || ''), 'tel:' + (c.phone || '').replace(/\s/g, '')],
       ['✉️ ' + (c.email || ''), 'mailto:' + (c.email || '')],
       ['📍 ' + (c.address || ''), '']].forEach(function (x) {
        var li = el('li');
        li.innerHTML = x[1] ? '<a href="' + x[1] + '">' + x[0] + '</a>' : x[0];
        fc.appendChild(li);
      });
    }

    var waMsg = encodeURIComponent('مرحبًا فانتا، أرغب في الاستفسار عن طباعة أكياس/حقائب دعائية لشركتي.');
    var waUrl = 'https://wa.me/' + (c.phoneRaw || '').replace(/[^\d]/g, '') + '?text=' + waMsg;
    var wa = $('waLink'); if (wa) wa.href = waUrl;
    var waf = $('wafloat'); if (waf) waf.href = waUrl;

    var y = $('year'); if (y) y.textContent = new Date().getFullYear();

    if (Array.isArray(CFG.stats) && CFG.stats.length) {
      var box = document.querySelector('.hero-stats');
      if (box) {
        box.innerHTML = '';
        CFG.stats.forEach(function (s) {
          var d = el('div');
          d.appendChild(el('strong', null, s.value));
          d.appendChild(el('span', null, s.label));
          box.appendChild(d);
        });
      }
    }
  }

  /* ==================================================================
     2) بطاقات المنتجات + منتقي الطلب + قائمة الفوتر
     ================================================================== */
  function cheapestUnit(product) {
    return product.tiers[product.tiers.length - 1].unitPrice;
  }

  function renderProducts() {
    var grid = $('productsGrid');
    var picker = $('productPicker');
    var footerList = $('footerProducts');
    if (grid) grid.innerHTML = '';
    if (picker) picker.innerHTML = '';
    if (footerList) footerList.innerHTML = '';

    CATALOG.products.forEach(function (p) {
      /* --- بطاقة في قسم المنتجات --- */
      var card = el('article', 'product-card');
      var media = el('div', 'media');
      var img = el('img');
      img.src = p.image;
      img.alt = p.name;
      img.loading = 'lazy';
      img.width = 600; img.height = 400;
      media.appendChild(img);
      if (p.badge) media.appendChild(el('span', 'card-badge', p.badge));
      card.appendChild(media);

      var body = el('div', 'body');
      body.appendChild(el('h3', null, p.name));
      body.appendChild(el('p', 'tag', p.tagline || ''));
      var price = el('div', 'price', 'يبدأ من ' + money(cheapestUnit(p)));
      price.appendChild(el('small', null, ' للقطعة · أقل كمية ' + fmtQty(p.minQty)));
      body.appendChild(price);
      var actions = el('div', 'actions');
      var btn = el('button', 'btn btn--outline btn--block', 'احسب السعر');
      btn.type = 'button';
      btn.addEventListener('click', function () {
        selectProduct(p.id, true);
      });
      actions.appendChild(btn);
      body.appendChild(actions);
      card.appendChild(body);
      if (grid) grid.appendChild(card);

      /* --- زر في منتقي الطلب --- */
      var pick = el('button', 'pick');
      pick.type = 'button';
      pick.setAttribute('aria-pressed', String(p.id === state.productId));
      var pimg = el('img'); pimg.src = p.image; pimg.alt = ''; pimg.loading = 'lazy';
      pick.appendChild(pimg);
      var txt = el('span');
      txt.appendChild(el('b', null, p.name));
      txt.appendChild(el('small', null, 'من ' + money(cheapestUnit(p))));
      pick.appendChild(txt);
      pick.addEventListener('click', function () { selectProduct(p.id, false); });
      if (picker) picker.appendChild(pick);

      /* --- رابط في الفوتر --- */
      if (footerList) {
        var li = el('li');
        var a = el('a', null, p.name);
        a.href = '#order';
        a.addEventListener('click', function () { selectProduct(p.id, true); });
        li.appendChild(a);
        footerList.appendChild(li);
      }
    });
  }

  function markActivePicker() {
    var picks = document.querySelectorAll('.pick');
    var names = CATALOG.products.map(function (p) { return p.id; });
    Array.prototype.forEach.call(picks, function (btn, i) {
      btn.setAttribute('aria-pressed', String(names[i] === state.productId));
    });
  }

  function selectProduct(id, scrollToOrder) {
    state.productId = id;
    var p = getProduct();
    state.selections = P.normalizeSelections(p);
    state.qty = p.minQty;
    renderSpecs();
    markActivePicker();
    if (scrollToOrder) {
      document.getElementById('order').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  /* ==================================================================
     3) بناء واجهة المواصفات من الكتالوج (بدون أي تكرار يدوي)
     ================================================================== */
  function renderSpecs() {
    var p = getProduct();
    var box = $('groupsBox');
    box.innerHTML = '';

    p.groups.forEach(function (g) {
      var wrap = el('div', 'group');
      var label = el('label', 'group-title');
      label.textContent = g.label + (g.required ? ' *' : '');
      wrap.appendChild(label);

      var opts = el('div', 'options');
      g.options.forEach(function (o) {
        var btn = el('button', 'opt');
        btn.type = 'button';
        btn.appendChild(el('span', null, o.label));
        var deltaNote = [];
        if (o.delta) deltaNote.push('+' + money(o.delta) + '/' + (p.unitLabel || 'قطعة'));
        if (o.flat) deltaNote.push('+' + money(o.flat) + ' (مرة واحدة)');
        if (deltaNote.length) btn.appendChild(el('span', 'delta', deltaNote.join(' · ')));
        btn.addEventListener('click', function () {
          if (g.type === 'multi') {
            var arr = state.selections[g.id] || [];
            var idx = arr.indexOf(o.id);
            if (idx >= 0) arr.splice(idx, 1); else arr.push(o.id);
            state.selections[g.id] = arr;
          } else {
            state.selections[g.id] = o.id;
          }
          renderSpecs();
        });
        if (g.type === 'multi') {
          var arr2 = state.selections[g.id] || [];
          btn.setAttribute('aria-pressed', String(arr2.indexOf(o.id) >= 0));
        } else {
          btn.setAttribute('aria-pressed', String(state.selections[g.id] === o.id));
        }
        opts.appendChild(btn);
      });
      wrap.appendChild(opts);
      box.appendChild(wrap);
    });

    renderQty(p);
    renderTiers(p);
    update();
  }

  function renderQty(p) {
    var input = $('qty');
    input.value = state.qty;
    input.min = p.minQty;
    input.step = p.qtyStep || 1;

    var help = $('qtyHelp');
    help.textContent = 'أقل كمية: ' + fmtQty(p.minQty) + ' ' + (p.unitLabel || 'قطعة') +
      (p.qtyStep > 1 ? ' · الزيادة بمضاعفات ' + fmtQty(p.qtyStep) : '');

    var chips = $('qtyChips');
    chips.innerHTML = '';
    var suggestions = [];
    p.tiers.forEach(function (t) { suggestions.push(t.minQty); });
    [p.minQty, Math.max(p.minQty, 250), 1000, 2500, 5000].forEach(function (n) {
      if (n >= p.minQty) suggestions.push(n);
    });
    suggestions = suggestions.filter(function (v, i, a) { return a.indexOf(v) === i; }).sort(function (a, b) { return a - b; }).slice(0, 5);
    suggestions.forEach(function (n) {
      var chip = el('button', 'chip' + (Number(n) === Number(state.qty) ? ' active' : ''), fmtQty(n));
      chip.type = 'button';
      chip.addEventListener('click', function () { setQty(n); });
      chips.appendChild(chip);
    });
  }

  function renderTiers(p) {
    var table = $('tierTable');
    table.innerHTML = '';
    var head = el('tr');
    ['شريحة الكمية', 'سعر الوحدة', 'سعر ' + fmtQty(Math.min(state.qty || p.minQty, 100000))].forEach(function (h, i) {
      var th = el('th', i === 0 ? '' : 'num', h);
      head.appendChild(th);
    });
    table.appendChild(head);

    var activeMin = null;
    p.tiers.forEach(function (t) { if (t.minQty <= state.qty) activeMin = t.minQty; });

    p.tiers.forEach(function (t, i) {
      var tr = el('tr');
      if (t.minQty === activeMin) tr.className = 'active';
      var next = p.tiers[i + 1];
      var range = next ? (fmtQty(t.minQty) + ' – ' + fmtQty(next.minQty - 1)) : (fmtQty(t.minQty) + ' فأكثر');
      tr.appendChild(el('td', null, range));
      tr.appendChild(el('td', 'num', money(t.unitPrice)));
      tr.appendChild(el('td', 'num', money(t.unitPrice * state.qty)));
      table.appendChild(tr);
    });
  }

  function setQty(n) {
    var p = getProduct();
    var v = parseInt(n, 10);
    if (isNaN(v)) v = p.minQty;
    if (v < p.minQty) v = p.minQty;
    var maxQty = SETTINGS.maxQty || 1000000;
    if (v > maxQty) v = maxQty;
    state.qty = v;
    $('qty').value = v;
    renderQty(p);
    renderTiers(p);
    update();
  }

  /* ==================================================================
     4) الحساب والعرض — الاستدعاء الوحيد للمحرك
     ================================================================== */
  function quote() {
    return P.computeQuote(CATALOG, {
      productId: state.productId,
      qty: state.qty,
      selections: state.selections,
      rush: state.rush,
      delivery: state.delivery
    });
  }

  function update() {
    var res = quote();
    var lines = $('lines');
    var errBox = $('errBox');
    var warnBox = $('warnBox');

    if (!res.ok) {
      errBox.innerHTML = '<b>تحقق من المدخلات:</b><ul>' +
        res.errors.map(function (e) { return '<li>' + escapeHtml(e) + '</li>'; }).join('') + '</ul>';
      errBox.classList.add('show');
      $('totalValue').textContent = '—';
      $('unitValue').textContent = '—';
      $('submitBtn').disabled = true;
      return;
    }
    errBox.classList.remove('show');
    $('submitBtn').disabled = false;

    var d = res.data;
    lines.innerHTML = '';
    d.lines.forEach(function (l) {
      var li = el('li', l.kind === 'tax' || l.kind === 'fee' ? '' : 'sub');
      li.appendChild(el('span', null, l.label));
      // بنود "لكل وحدة" نوضّح أنها تُضاف إلى سعر الوحدة لا إلى الإجمالي مباشرةً
      var amount = l.kind === 'perUnit' ? money(l.amount) + ' × ' + fmtQty(d.qty) : money(l.amount);
      li.appendChild(el('span', null, amount));
      lines.appendChild(li);
    });

    var production = el('li', 'sub');
    production.appendChild(el('span', null, 'قيمة الإنتاج (' + fmtQty(d.qty) + ' × ' + money(d.perUnit) + ')'));
    production.appendChild(el('span', null, money(d.production)));
    lines.insertBefore(production, lines.children[d.lines.filter(function (l) { return l.kind === 'perUnit'; }).length] || null);

    var total = el('li', 'total');
    total.appendChild(el('span', null, 'الإجمالي شامل الضريبة'));
    total.appendChild(el('span', null, money(d.total)));
    lines.appendChild(total);

    $('totalValue').textContent = money(d.total);
    $('unitValue').textContent = 'سعر الوحدة: ' + money(d.perUnit) + ' · مدة التنفيذ المتوقعة: ' +
      d.leadTimeDays + ' يوم' + (d.rush ? ' (مسار عاجل)' : '');

    // تنبيه ودود: الشحن المجاني
    if (state.delivery && d.delivery === 0) {
      warnBox.textContent = '🎉 طلبك مؤهل لتوصيل مجاني (الإنتاج فوق ' + money(SETTINGS.freeDeliveryThreshold) + ').';
      warnBox.classList.add('show');
    } else {
      warnBox.classList.remove('show');
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ==================================================================
     5) الإرسال
     ================================================================== */
  function validateCustomer(values) {
    var errors = {};
    if (values.name.trim().length < 3) errors.name = 'الاسم مطلوب (٣ أحرف على الأقل)';
    var digits = values.phone.replace(/[^\d]/g, '');
    if (digits.length < 9 || digits.length > 15) errors.phone = 'أدخل رقم جوال صحيح';
    if (values.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(values.email)) errors.email = 'صيغة البريد غير صحيحة';
    if (values.notes.length > 1000) errors.notes = 'الملاحظات طويلة جدًا';
    return errors;
  }

  function showFieldErrors(errors) {
    ['name', 'company', 'phone', 'email', 'city', 'notes'].forEach(function (k) {
      var f = $('f-' + k);
      if (!f) return;
      var slot = f.querySelector('.err');
      if (errors[k]) {
        f.classList.add('invalid');
        slot.textContent = errors[k];
      } else {
        f.classList.remove('invalid');
        slot.textContent = '';
      }
    });
  }

  function submit() {
    if (state.submitting) return;

    var res = quote();
    if (!res.ok) { update(); return; }

    var values = {
      name: $('cName').value,
      company: $('cCompany').value,
      phone: $('cPhone').value,
      email: $('cEmail').value,
      city: $('cCity').value,
      notes: $('cNotes').value
    };
    var errors = validateCustomer(values);
    showFieldErrors(errors);
    if (Object.keys(errors).length) {
      $('f-' + Object.keys(errors)[0]).scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }

    var payload = {
      productId: state.productId,
      qty: state.qty,
      selections: state.selections,
      rush: state.rush,
      delivery: state.delivery,
      customer: values,
      clientTotal: res.data.total,
      clientCalcHash: res.data.calcHash,
      pricingVersion: P.PRICING_VERSION,
      meta: {
        page: location.href,
        ua: navigator.userAgent.slice(0, 200),
        submittedAt: new Date().toISOString()
      }
    };

    var endpoint = (CFG.ORDER_ENDPOINT || '').trim();
    if (!endpoint) { demoSubmit(payload, res.data); return; }

    state.submitting = true;
    var btn = $('submitBtn');
    btn.disabled = true;
    var oldText = btn.textContent;
    btn.textContent = 'جارٍ الإرسال…';

    fetch(endpoint, {
      method: 'POST',
      redirect: 'follow',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // يمنع طلب OPTIONS المسبق
      body: JSON.stringify(payload)
    })
      .then(function (r) { return r.json(); })
      .then(function (json) {
        if (!json.ok) {
          var box = $('errBox');
          box.innerHTML = '<b>تعذّر إرسال الطلب:</b><ul>' +
            (json.errors || ['خطأ غير معروف']).map(function (e) { return '<li>' + escapeHtml(e) + '</li>'; }).join('') + '</ul>';
          box.classList.add('show');
          return;
        }
        showReceipt(json, res.data);
      })
      .catch(function () {
        var box = $('errBox');
        box.innerHTML = '<b>تعذّر الاتصال بالخادم.</b> تحقق من الإنترنت أو تواصل معنا عبر الواتساب.';
        box.classList.add('show');
      })
      .finally(function () {
        state.submitting = false;
        btn.disabled = false;
        btn.textContent = oldText;
      });
  }

  /** الوضع التجريبي: لا يوجد رابط Apps Script بعد */
  function demoSubmit(payload, local) {
    var orderNo = 'DEMO-' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-' +
      Math.floor(Math.random() * 9000 + 1000);
    showReceipt({
      ok: true,
      orderNo: orderNo,
      totals: {
        total: local.total, tax: local.tax, perUnit: local.perUnit,
        taxable: local.taxable, currency: local.currency,
        totalFormatted: money(local.total)
      },
      leadTimeDays: local.leadTimeDays,
      match: 'تجريبي (لم يُرسل للخادم)',
      calcHash: local.calcHash
    }, local, payload);
  }

  function showReceipt(json, local, payload) {
    var t = json.totals || {};
    var box = $('receipt');
    var mismatch = (t.total !== undefined && t.total !== local.total);

    var html = '';
    html += '<div class="no">طلبك رقم: ' + escapeHtml(json.orderNo) + '</div>';
    html += '<p style="margin:8px 0 0;color:var(--muted);font-size:13px">' +
      'حالة الحساب: ' + escapeHtml(json.match || '—') + ' · مدة التنفيذ: ' + escapeHtml(String(json.leadTimeDays || '—')) + ' يوم</p>';
    html += '<dl>';
    html += '<dt>المنتج</dt><dd>' + escapeHtml(local.productName) + '</dd>';
    html += '<dt>الكمية</dt><dd>' + fmtQty(local.qty) + ' ' + escapeHtml(local.unitLabel) + '</dd>';
    html += '<dt>سعر الوحدة</dt><dd>' + money(local.perUnit) + '</dd>';
    html += '<dt>الإجمالي المعتمد</dt><dd>' + money(t.total !== undefined ? t.total : local.total) + '</dd>';
    html += '</dl>';

    if (mismatch) {
      html += '<div class="alert alert--warn show" style="margin-top:12px">' +
        'ملاحظة: الخادم أعاد إجماليًا مختلفًا عن العرض الأولي (' + money(t.total) +
        '). القيمة المعتمدة هي قيمة الخادم، وقد نتج الاختلاف عن تحديث الأسعار.</div>';
      $('totalValue').textContent = money(t.total);
    }

    html += '<div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap">' +
      '<button class="btn btn--outline" id="copyBtn" type="button">نسخ بيانات الطلب</button>' +
      '<button class="btn btn--outline" id="waOrderBtn" type="button">إرسال الطلب واتساب</button>' +
      '</div>';
    box.innerHTML = html;
    box.classList.add('show');
    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    var jsonText = JSON.stringify({
      orderNo: json.orderNo,
      product: local.productName,
      qty: local.qty,
      selections: local.selections,
      perUnit: local.perUnit,
      production: local.production,
      flats: local.flats,
      rush: local.rush,
      delivery: local.delivery,
      taxable: local.taxable,
      tax: local.tax,
      total: t.total !== undefined ? t.total : local.total,
      currency: local.currency.code,
      customer: (payload && payload.customer) || {}
    }, null, 2);

    var copyBtn = $('copyBtn');
    if (copyBtn) {
      copyBtn.addEventListener('click', function () {
        if (navigator.clipboard) {
          navigator.clipboard.writeText(jsonText).then(function () {
            copyBtn.textContent = 'تم النسخ ✓';
          });
        }
      });
    }
    var waBtn = $('waOrderBtn');
    if (waBtn) {
      var text = encodeURIComponent('طلب جديد ' + json.orderNo + '\n' +
        local.productName + ' — ' + fmtQty(local.qty) + ' ' + local.unitLabel + '\n' +
        'الإجمالي: ' + money(t.total !== undefined ? t.total : local.total));
      waBtn.addEventListener('click', function () {
        window.open('https://wa.me/' + ((CFG.company && CFG.company.phoneRaw) || '').replace(/[^\d]/g, '') + '?text=' + text, '_blank');
      });
    }
  }

  /* ==================================================================
     6) الربط والتشغيل
     ================================================================== */
  function bind() {
    var burger = $('burger'), nav = $('nav');
    if (burger && nav) {
      burger.addEventListener('click', function () {
        var open = nav.classList.toggle('open');
        burger.setAttribute('aria-expanded', String(open));
      });
      nav.addEventListener('click', function (e) {
        if (e.target.tagName === 'A') { nav.classList.remove('open'); burger.setAttribute('aria-expanded', 'false'); }
      });
    }

    var qty = $('qty');
    qty.addEventListener('input', function () {
      var v = qty.value.replace(/[^\d]/g, '');
      if (v === '') { state.qty = 0; update(); return; }
      var p = getProduct();
      var n = parseInt(v, 10);
      var maxQty = SETTINGS.maxQty || 1000000;
      if (n > maxQty) n = maxQty;
      state.qty = n;
      renderTiers(p);
      update();
    });
    qty.addEventListener('blur', function () { setQty(qty.value || getProduct().minQty); });
    $('qtyMinus').addEventListener('click', function () {
      var p = getProduct();
      setQty(Math.max(p.minQty, state.qty - (p.qtyStep || 1)));
    });
    $('qtyPlus').addEventListener('click', function () {
      var p = getProduct();
      setQty(state.qty + (p.qtyStep || 1));
    });

    $('flagRush').addEventListener('change', function (e) { state.rush = e.target.checked; update(); });
    $('flagDelivery').addEventListener('change', function (e) { state.delivery = e.target.checked; update(); });

    $('submitBtn').addEventListener('click', submit);
    $('orderForm').addEventListener('submit', function (e) { e.preventDefault(); submit(); });

    // رابط مباشر لمنتج: index.html?product=cotton-tote
    var m = location.search.match(/[?&]product=([^&]+)/);
    if (m) {
      var found = CATALOG.products.filter(function (p) { return p.id === decodeURIComponent(m[1]); })[0];
      if (found) { state.productId = found.id; }
    }
  }

  function initDemoNote() {
    var note = $('demoNote');
    if (!note) return;
    if (!(CFG.ORDER_ENDPOINT || '').trim()) {
      note.innerHTML = '<b>وضع تجريبي:</b> الطلب يُحسب محليًا ولا يُرسل إلى Google Sheets بعد. ' +
        'لتفعيل الربط: ضع رابط Apps Script في <code>ORDER_ENDPOINT</code> داخل ملف <code>assets/config.js</code>.';
    } else {
      note.style.display = 'none';
    }
  }

  function init() {
    if (!CATALOG || !P) {
      document.getElementById('order').innerHTML =
        '<div class="panel"><b>خطأ:</b> ملفات التسعير غير محمّلة. شغّل <code>node tools/build.mjs</code>.</div>';
      return;
    }
    renderCompanyInfo();
    renderProducts();

    var p = getProduct();
    state.selections = P.normalizeSelections(p);
    state.qty = p.minQty;

    initDemoNote();
    bind();
    renderSpecs();

    var m = location.search.match(/[?&]product=([^&]+)/);
    if (m) {
      document.getElementById('order').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
