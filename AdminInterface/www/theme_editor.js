/* Theme editor (MuPiBox settings -> Theme -> "Customize this theme").
 *
 * The master theme file is never changed: what you edit here is an override (themes/<theme>.user.css), and every save
 * makes a backup of the override before it (server side, theme_editor.php).
 *
 * The preview is the real display (port 8200) in a frame. Colours and element rules are sent to it as css while you
 * edit (postMessage, see theme-preview.service.ts in the display), before anything is saved. In the preview you can
 * tap an element to select it, drag it to move it and drag its corner handle to resize it.
 */
(function () {
	'use strict';
	var cfg = window.MUPI_THEME_EDITOR;
	var root = document.getElementById('themeEditor');
	var openBtn = document.getElementById('themeEditorOpen');
	var themeSelect = document.getElementById('theme');
	if (!cfg || !root || !openBtn || !themeSelect) return;

	var frameOrigin = location.protocol + '//' + location.hostname + ':8200';
	var SCREENS = [
		['/home', 'Start page'],
		['/text-preview?screen=blocked', 'Overlay: limit reached'],
		['/text-preview?screen=quiet', 'Overlay: quiet time'],
		['/text-preview?screen=parents', 'Overlay: parents QR code']
	];

	// ------------------------------------------------------------------ state
	var theme = null;                 // the theme being edited
	var masterCss = '';
	var masterVars = {};              // --name -> value in the master theme (in file order)
	var model = { vars: {}, rules: [] };
	var savedJson = '';
	var backups = [];
	var picked = null;                // what the preview reported for the selected element
	var scope = 'all';                // 'all' | 'only'
	var pickOn = false;
	var frameReady = false;
	var pushTimer = null;
	var ui = {};                      // the elements of the editor

	// ------------------------------------------------------------------ small helpers
	function el(tag, attrs, kids) {
		var e = document.createElement(tag);
		Object.keys(attrs || {}).forEach(function (k) {
			if (attrs[k] === null || attrs[k] === undefined) return;
			if (k === 'text') e.textContent = attrs[k];
			else if (k === 'class') e.className = attrs[k];
			else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), attrs[k]);
			else e.setAttribute(k, attrs[k]);
		});
		[].concat(kids || []).forEach(function (c) { if (c) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
		return e;
	}
	function clone(o) { return JSON.parse(JSON.stringify(o)); }
	function modelJson() { return JSON.stringify(model); }
	function dirty() { return modelJson() !== savedJson; }
	function msg(text, kind) { ui.msg.textContent = text || ''; ui.msg.className = 'te-msg ' + (kind || ''); }
	function px(v) { var n = parseFloat(v); return isNaN(n) ? 0 : Math.round(n * 10) / 10; }

	function api(action, params, post) {
		var url = cfg.api + '?action=' + encodeURIComponent(action) + '&theme=' + encodeURIComponent(theme);
		var opt = { credentials: 'same-origin' };
		if (post) {
			var body = new URLSearchParams(params || {});
			body.set('csrf_token', cfg.csrf);
			opt.method = 'POST';
			opt.body = body;
		}
		return fetch(url, opt).then(function (r) {
			return r.text().then(function (t) {
				var j = null;
				try { j = JSON.parse(t); } catch (e) { /* not json */ }
				if (!r.ok || !j || j.ok === false) throw new Error((j && j.error) || (r.status === 401 ? 'Please sign in again (reload the page).' : 'Request failed (' + r.status + ').'));
				return j;
			});
		});
	}

	// ------------------------------------------------------------------ colours
	var cctx = document.createElement('canvas').getContext('2d');
	function parseColor(v) {
		if (!v) return null;
		cctx.fillStyle = '#010203';
		cctx.fillStyle = String(v).trim();
		var s = cctx.fillStyle;
		if (s === '#010203' && String(v).trim().toLowerCase() !== '#010203') return null;
		if (s.charAt(0) === '#') return { hex: s, a: 1 };
		var m = s.match(/rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/);
		if (!m) return null;
		var h = '#' + [m[1], m[2], m[3]].map(function (n) { return ('0' + (+n).toString(16)).slice(-2); }).join('');
		return { hex: h, a: m[4] === undefined ? 1 : parseFloat(m[4]) };
	}
	function colorString(hex, a) {
		if (a >= 1) return hex;
		var n = parseInt(hex.slice(1), 16);
		return 'rgba(' + (n >> 16 & 255) + ', ' + (n >> 8 & 255) + ', ' + (n & 255) + ', ' + (Math.round(a * 100) / 100) + ')';
	}
	function looksLikeColor(v) {
		v = String(v).trim();
		if (/^(#[0-9a-f]{3,8}|rgba?\(|hsla?\()/i.test(v)) return !!parseColor(v);
		return /^[a-z]+$/i.test(v) && v !== 'none' && v !== 'inherit' && v !== 'initial' && !!parseColor(v);
	}

	// colour + opacity + text, one control; onChange gets the css colour
	function colorControl(value, onChange) {
		var c = parseColor(value) || { hex: '#000000', a: 1 };
		var picker = el('input', { type: 'color', value: c.hex, title: 'Colour' });
		var alpha = el('input', { type: 'range', min: 0, max: 100, value: Math.round(c.a * 100), title: 'Opacity' });
		var text = el('input', { type: 'text', class: 'te-val', value: value || colorString(c.hex, c.a) });
		function fromPicker() { var s = colorString(picker.value, alpha.value / 100); text.value = s; onChange(s); }
		picker.addEventListener('input', fromPicker);
		alpha.addEventListener('input', fromPicker);
		text.addEventListener('change', function () {
			var p = parseColor(text.value);
			if (!p) { text.value = colorString(picker.value, alpha.value / 100); return; }
			picker.value = p.hex; alpha.value = Math.round(p.a * 100);
			onChange(colorString(p.hex, p.a));
			text.value = colorString(p.hex, p.a);
		});
		return el('span', { class: 'te-ctl' }, [picker, alpha, text]);
	}
	function numberControl(value, min, max, step, onChange, suffix) {
		var n = el('input', { type: 'number', min: min, max: max, step: step, value: value, style: 'width:70px' });
		n.addEventListener('input', function () { if (n.value !== '') onChange(parseFloat(n.value)); });
		return el('span', { class: 'te-ctl' }, [n, suffix || '']);
	}
	function rangeControl(value, min, max, step, onChange, suffix) {
		var r = el('input', { type: 'range', min: min, max: max, step: step, value: value });
		var n = el('input', { type: 'number', min: min, max: max, step: step, value: value, style: 'width:60px' });
		r.addEventListener('input', function () { n.value = r.value; onChange(parseFloat(r.value)); });
		n.addEventListener('input', function () { if (n.value !== '') { r.value = n.value; onChange(parseFloat(n.value)); } });
		return el('span', { class: 'te-ctl' }, [r, n, suffix || '']);
	}
	function row(label, control, changed) {
		return el('div', { class: 'te-row' + (changed ? ' changed' : '') }, [el('label', { text: label }), control]);
	}

	// ------------------------------------------------------------------ the theme's colours
	function parseMasterVars(css) {
		var vars = {};
		css = css.replace(/\/\*[\s\S]*?\*\//g, '');
		var re = /([^{}]+)\{([^{}]*)\}/g, m;
		while ((m = re.exec(css))) {
			var sel = m[1].trim();
			if (!/(^|[\s,])(:root|html|body)\b/.test(sel) || sel.charAt(0) === '@') continue;
			var dre = /(--[A-Za-z0-9_-]+)\s*:\s*([^;]+);?/g, d;
			while ((d = dre.exec(m[2]))) vars[d[1]] = d[2].replace(/!important/i, '').trim();
		}
		return vars;
	}

	// ------------------------------------------------------------------ css for the preview (the same as theme_editor.php makes)
	function prefixed(sel) { return /^(html|body|:root)\b/.test(sel) ? sel : ':root:root:root:root:root ' + sel; }
	function modelToCss(m) {
		var css = '', names = Object.keys(m.vars);
		if (names.length) {
			css += ':root, body, body[class*="km-theme-"] {\n';
			names.forEach(function (k) { css += '  ' + k + ': ' + m.vars[k] + ' !important;\n'; });
			css += '}\n';
		}
		m.rules.forEach(function (r) {
			css += prefixed(r.sel) + ' {';
			Object.keys(r.props).forEach(function (p) { css += ' ' + p + ': ' + r.props[p] + ' !important;'; });
			css += ' }\n';
		});
		return css;
	}

	// ------------------------------------------------------------------ the preview frame
	function frameWin() { return ui.frame && ui.frame.contentWindow; }
	function send(data) { var w = frameWin(); if (w && frameReady) w.postMessage(data, frameOrigin); }
	function pushCss() {
		clearTimeout(pushTimer);
		pushTimer = setTimeout(function () {
			send({ type: 'mupibox-theme-css', themeId: theme, masterCss: masterCss, css: modelToCss(model) });
			updateDirty();
		}, 80);
	}
	function loadScreen() {
		frameReady = false;
		ui.frame.src = frameOrigin + ui.screen.value;
	}
	function fitFrame() {
		var avail = ui.stage.clientWidth || 800;
		var s = Math.min(1, avail / 800);
		ui.frameWrap.style.transform = 'scale(' + s + ')';
		ui.clip.style.width = Math.round(800 * s) + 'px';
		ui.clip.style.height = Math.round(480 * s) + 'px';
	}
	window.addEventListener('message', function (ev) {
		if (!ui.frame || ev.origin !== frameOrigin || ev.source !== frameWin()) return;
		var d = ev.data || {};
		if (d.type === 'mupibox-theme-ready') {
			frameReady = true;
			pushCss();
			if (pickOn) send({ type: 'mupibox-theme-pick', on: true });
		} else if (d.type === 'mupibox-theme-picked') {
			picked = d;
			renderElement();
		} else if (d.type === 'mupibox-theme-moved') {
			setProp('translate', d.translate);
			renderElement(true);
		} else if (d.type === 'mupibox-theme-resized') {
			setProp('width', d.width);
			setProp('height', d.height);
			renderElement(true);
		}
	});

	// ------------------------------------------------------------------ element rules
	function currentSel() { return picked ? picked.selectors[scope].sel : ''; }
	function findRule(sel, create) {
		for (var i = 0; i < model.rules.length; i++) if (model.rules[i].sel === sel) return model.rules[i];
		if (!create) return null;
		var r = { sel: sel, props: {} };
		model.rules.push(r);
		return r;
	}
	function ruleProps() { var r = findRule(currentSel(), false); return r ? r.props : {}; }
	function setProp(prop, value) {
		var sel = currentSel();
		if (!sel) return;
		var r = findRule(sel, true);
		if (value === null || value === undefined || value === '') delete r.props[prop]; else r.props[prop] = String(value);
		if (!Object.keys(r.props).length) model.rules.splice(model.rules.indexOf(r), 1);
		pushCss();
		renderChanged();
	}
	function setProps(obj) { Object.keys(obj).forEach(function (k) { setProp(k, obj[k]); }); }
	function cur(prop, fallback) { var p = ruleProps(); return p[prop] !== undefined ? p[prop] : fallback; }

	function renderElement(keepPickMode) {
		var box = ui.element;
		box.textContent = '';
		box.appendChild(el('button', {
			type: 'button', class: 'te-btn' + (pickOn ? ' on' : ''), text: pickOn ? 'Selecting: tap, drag or resize in the preview' : 'Select elements in the preview',
			onclick: function () { setPick(!pickOn); }
		}));
		box.appendChild(el('p', { class: 'te-hint', text: 'Switch it on, then tap an element in the picture. Drag it to move it, drag the round handle in its corner to resize it. Switch it off to use the display (tap through the pages) as usual.' }));
		if (!picked) {
			box.appendChild(el('div', { class: 'te-emptynote', text: 'No element selected.' }));
			return;
		}
		var s = picked.styles || {};
		box.appendChild(el('div', { class: 'te-group', text: 'Selected: ' + picked.label }));

		// which elements the change is for
		var scopeBox = el('div', { class: 'te-scope' });
		[['all', 'All like this'], ['only', 'Only this one']].forEach(function (o) {
			var rb = el('input', { type: 'radio', name: 'te_scope', value: o[0] });
			if (scope === o[0]) rb.checked = true;
			rb.addEventListener('change', function () { scope = o[0]; renderElement(true); });
			scopeBox.appendChild(el('label', {}, [rb, o[1] + ' (' + picked.selectors[o[0]].count + ' on this page)']));
		});
		box.appendChild(scopeBox);
		box.appendChild(el('div', { class: 'te-sel', text: currentSel() }));
		box.appendChild(el('div', { class: 'te-top' }, [
			el('button', { type: 'button', class: 'te-btn ghost', text: 'Parent element', disabled: picked.canUp ? null : 'disabled', onclick: function () { send({ type: 'mupibox-theme-relative', dir: 'up' }); } }),
			el('button', { type: 'button', class: 'te-btn ghost', text: 'Inner element', disabled: picked.canDown ? null : 'disabled', onclick: function () { send({ type: 'mupibox-theme-relative', dir: 'down' }); } })
		]));
		if (picked.selectors[scope].count === 0) box.appendChild(el('div', { class: 'te-emptynote', text: 'This selector matches nothing on the page.' }));

		var rp = ruleProps();
		function changed(prop) { return rp[prop] !== undefined; }

		box.appendChild(el('div', { class: 'te-group', text: 'Colours' }));
		box.appendChild(row('Background', colorControl(cur('background', s['background-color']), function (v) { setProp('background', v); }), changed('background')));
		box.appendChild(row('Text colour', colorControl(cur('color', s['color']), function (v) { setProp('color', v); }), changed('color')));

		box.appendChild(el('div', { class: 'te-group', text: 'Shape' }));
		var radius = cur('border-radius', px(s['border-top-left-radius']) + 'px');
		box.appendChild(row('Corner radius', el('span', { class: 'te-ctl' }, [
			rangeControl(px(radius), 0, 150, 1, function (v) { setProp('border-radius', v + 'px'); }, 'px'),
			el('button', { type: 'button', class: 'te-btn ghost', text: 'Circle', onclick: function () { setProp('border-radius', '50%'); } })
		]), changed('border-radius')));

		var bm = String(cur('border', '')).match(/^([\d.]+)px\s+solid\s+(.+)$/);
		var bw = bm ? parseFloat(bm[1]) : px(s['border-top-width']);
		var bc = bm ? bm[2] : s['border-top-color'];
		function setBorder(w, c) { setProp('border', w > 0 ? w + 'px solid ' + c : '0 none transparent'); }
		var bcState = bc;
		box.appendChild(row('Border width', rangeControl(bw, 0, 24, 1, function (v) { bw = v; setBorder(bw, bcState); }, 'px'), changed('border')));
		box.appendChild(row('Border colour', colorControl(bc, function (v) { bcState = v; setBorder(bw, bcState); }), changed('border')));

		var sm = String(cur('box-shadow', s['box-shadow'] || '')).match(/(-?[\d.]+)px\s+(-?[\d.]+)px\s+(-?[\d.]+)px(?:\s+-?[\d.]+px)?/);
		var sh = { x: sm ? +sm[1] : 0, y: sm ? +sm[2] : 0, b: sm ? +sm[3] : 0, c: '#000000' };
		var cm = String(cur('box-shadow', s['box-shadow'] || '')).match(/(rgba?\([^)]*\)|#[0-9a-f]{3,8})/i);
		if (cm) sh.c = cm[1];
		function setShadow() { setProp('box-shadow', sh.x + 'px ' + sh.y + 'px ' + sh.b + 'px ' + sh.c); }
		box.appendChild(row('Shadow x / y', el('span', { class: 'te-ctl' }, [
			numberControl(sh.x, -60, 60, 1, function (v) { sh.x = v; setShadow(); }),
			numberControl(sh.y, -60, 60, 1, function (v) { sh.y = v; setShadow(); }),
			el('button', { type: 'button', class: 'te-btn ghost', text: 'None', onclick: function () { setProp('box-shadow', 'none'); renderElement(true); } })
		]), changed('box-shadow')));
		box.appendChild(row('Shadow blur', rangeControl(sh.b, 0, 60, 1, function (v) { sh.b = v; setShadow(); }, 'px'), changed('box-shadow')));
		box.appendChild(row('Shadow colour', colorControl(sh.c, function (v) { sh.c = v; setShadow(); }), changed('box-shadow')));

		box.appendChild(el('div', { class: 'te-group', text: 'Size and position' }));
		box.appendChild(row('Width', numberControl(px(cur('width', s['width'])), 0, 800, 1, function (v) { setProp('width', v + 'px'); }, 'px'), changed('width')));
		box.appendChild(row('Height', numberControl(px(cur('height', s['height'])), 0, 480, 1, function (v) { setProp('height', v + 'px'); }, 'px'), changed('height')));
		var tm = String(cur('translate', s['translate'] || 'none')).split(/\s+/);
		var tr = { x: tm[0] === 'none' ? 0 : px(tm[0]), y: tm[1] ? px(tm[1]) : 0 };
		function setTranslate() { setProp('translate', tr.x + 'px ' + tr.y + 'px'); }
		box.appendChild(row('Move right / down', el('span', { class: 'te-ctl' }, [
			numberControl(tr.x, -800, 800, 1, function (v) { tr.x = v; setTranslate(); }),
			numberControl(tr.y, -480, 480, 1, function (v) { tr.y = v; setTranslate(); })
		]), changed('translate')));

		box.appendChild(el('div', { class: 'te-group', text: 'Text and visibility' }));
		box.appendChild(row('Font size', numberControl(px(cur('font-size', s['font-size'])), 6, 120, 1, function (v) { setProp('font-size', v + 'px'); }, 'px'), changed('font-size')));
		var fw = el('select', {}, ['300', '400', '500', '600', '700', '800'].map(function (w) { return el('option', { value: w, text: w }); }));
		fw.value = String(cur('font-weight', s['font-weight'] || '400'));
		fw.addEventListener('change', function () { setProp('font-weight', fw.value); });
		box.appendChild(row('Font weight', el('span', { class: 'te-ctl' }, [fw]), changed('font-weight')));
		box.appendChild(row('Opacity', rangeControl(Math.round(parseFloat(cur('opacity', s['opacity'] || '1')) * 100), 0, 100, 1, function (v) { setProp('opacity', v / 100); }, '%'), changed('opacity')));
		box.appendChild(el('div', { class: 'te-top', style: 'margin-top:10px' }, [
			el('button', {
				type: 'button', class: 'te-btn warn', text: 'Undo all changes of this selector', onclick: function () {
					var r = findRule(currentSel(), false);
					if (r) { model.rules.splice(model.rules.indexOf(r), 1); pushCss(); renderChanged(); renderElement(true); }
				}
			})
		]));
	}

	function renderChanged() {
		var box = ui.changed;
		box.textContent = '';
		if (!model.rules.length) { box.appendChild(el('div', { class: 'te-emptynote', text: 'No element has been changed yet.' })); return; }
		model.rules.forEach(function (r) {
			var props = Object.keys(r.props).map(function (p) { return p + ': ' + r.props[p]; }).join('; ');
			box.appendChild(el('div', { class: 'te-bk' }, [
				el('div', {}, [el('div', { class: 'te-sel', text: r.sel }), el('small', { text: props })]),
				el('button', { type: 'button', class: 'te-x', title: 'Remove', text: '✕', onclick: function () { model.rules.splice(model.rules.indexOf(r), 1); pushCss(); renderChanged(); if (picked) renderElement(true); } })
			]));
		});
	}

	// ------------------------------------------------------------------ colours pane
	function renderColors() {
		var box = ui.colors;
		box.textContent = '';
		var names = Object.keys(masterVars);
		if (!names.length) { box.appendChild(el('div', { class: 'te-emptynote', text: 'This theme has no colour variables of its own. Use "Elements" to change single parts.' })); return; }
		box.appendChild(el('p', { class: 'te-hint', text: 'The colours of the theme. A change shows in the preview at once. Marked rows differ from the master theme.' }));
		names.forEach(function (name) {
			var base = masterVars[name], over = model.vars[name], value = over !== undefined ? over : base;
			var ctl;
			if (looksLikeColor(base)) {
				ctl = colorControl(value, function (v) { setVar(name, v, base); });
			} else {
				var t = el('input', { type: 'text', class: 'te-val', value: value, style: 'width:200px' });
				t.addEventListener('change', function () { setVar(name, t.value.trim(), base); });
				ctl = el('span', { class: 'te-ctl' }, [t]);
			}
			var reset = el('button', { type: 'button', class: 'te-x', title: 'Back to the master value', text: '↺', onclick: function () { delete model.vars[name]; pushCss(); renderColors(); } });
			var r = row(name.replace(/^--/, ''), el('span', { class: 'te-ctl' }, [ctl, reset]), over !== undefined);
			box.appendChild(r);
		});
	}
	function setVar(name, value, base) {
		if (!value || value === base) delete model.vars[name]; else model.vars[name] = value;
		pushCss();
		var rows = ui.colors.querySelectorAll('.te-row');
		var idx = Object.keys(masterVars).indexOf(name);
		if (rows[idx]) rows[idx].classList.toggle('changed', model.vars[name] !== undefined);
	}

	// ------------------------------------------------------------------ backups pane
	function renderBackups() {
		var box = ui.backups;
		box.textContent = '';
		box.appendChild(el('p', { class: 'te-hint', text: 'Every save makes a backup of the design as it was before. Restoring one also makes a backup of the current design first, so nothing is lost.' }));
		box.appendChild(el('div', { class: 'te-top' }, [
			el('button', { type: 'button', class: 'te-btn warn', text: 'Restore the master design', onclick: resetMaster })
		]));
		if (!backups.length) { box.appendChild(el('div', { class: 'te-emptynote', text: 'No backups yet.' })); return; }
		backups.forEach(function (b) {
			box.appendChild(el('div', { class: 'te-bk' }, [
				el('div', {}, [b.time + (b.label ? ' – ' + b.label : ''), el('br'), el('small', { text: b.vars + ' colours, ' + b.rules + ' element rules' })]),
				el('button', { type: 'button', class: 'te-btn ghost', text: 'Restore', onclick: function () { restore(b); } })
			]));
		});
	}

	// ------------------------------------------------------------------ actions
	function applyServerState(j) {
		if (j.model) { model = { vars: Object.assign({}, j.model.vars || {}), rules: j.model.rules || [] }; }
		if (j.backups) backups = j.backups;
		savedJson = modelJson();
		renderColors(); renderChanged(); renderBackups(); picked = null; renderElement(); pushCss(); updateDirty();
	}
	function load(id) {
		theme = id;
		ui.title.textContent = 'Customize the theme "' + id + '"';
		msg('Loading…');
		return api('load', {}, false).then(function (j) {
			masterCss = j.masterCss;
			masterVars = parseMasterVars(masterCss);
			applyServerState(j);
			msg(j.hasOverride ? 'This theme has your changes.' : 'This theme is the master design (no changes yet).', 'ok');
		}).catch(function (e) { msg(e.message, 'err'); });
	}
	function save() {
		msg('Saving…');
		api('save', { model: modelJson(), label: ui.note.value }, true).then(function (j) {
			applyServerState(j);
			ui.note.value = '';
			msg('Saved. A backup of the design before this change was made. If this is the theme in use, the display restarts now.', 'ok');
		}).catch(function (e) { msg(e.message, 'err'); });
	}
	function resetMaster() {
		if (!confirm('Go back to the master design of "' + theme + '"? Your changes are backed up first and can be restored.')) return;
		api('reset', {}, true).then(function (j) { applyServerState(j); msg('The master design is active again. Your changes are in the backups.', 'ok'); })
			.catch(function (e) { msg(e.message, 'err'); });
	}
	function restore(b) {
		if (!confirm('Restore the backup from ' + b.time + '? The current design is backed up first.')) return;
		api('restore', { id: b.id }, true).then(function (j) { applyServerState(j); msg('Backup restored.', 'ok'); })
			.catch(function (e) { msg(e.message, 'err'); });
	}
	function updateDirty() {
		ui.save.disabled = !dirty();
		ui.save.textContent = dirty() ? 'Save (unsaved changes)' : 'Save';
	}
	function setPick(on) {
		pickOn = on;
		send({ type: 'mupibox-theme-pick', on: on });
		renderElement(true);
	}
	function showTab(name) {
		['colors', 'element', 'changed', 'backups'].forEach(function (n) {
			ui[n].classList.toggle('active', n === name);
			ui['tab_' + n].classList.toggle('active', n === name);
		});
		if (name === 'element') setPick(true); else if (pickOn) setPick(false);
	}

	// ------------------------------------------------------------------ build
	function build() {
		ui.title = el('span', { class: 'te-title', text: 'Customize this theme' });
		ui.screen = el('select', {}, SCREENS.map(function (s) { return el('option', { value: s[0], text: s[1] }); }));
		ui.screen.addEventListener('change', loadScreen);
		ui.save = el('button', { type: 'button', class: 'te-btn', text: 'Save', onclick: save });
		ui.note = el('input', { type: 'text', placeholder: 'Note for this version (optional)', maxlength: 30, style: 'width:190px' });
		ui.msg = el('div', { class: 'te-msg' });
		ui.frame = el('iframe', { title: 'Preview of the box display', allow: '' });
		ui.frameWrap = el('div', { class: 'te-frame-wrap' }, [ui.frame]);
		ui.clip = el('div', { class: 'te-frame-clip' }, [ui.frameWrap]);
		ui.stage = el('div', { class: 'te-stage' }, [
			el('div', { class: 'te-top' }, [el('label', { text: 'Preview', style: 'float:none;margin:0;font-size:12px' }), ui.screen]),
			ui.clip
		]);
		ui.colors = el('div', { class: 'te-pane active' });
		ui.element = el('div', { class: 'te-pane' });
		ui.changed = el('div', { class: 'te-pane' });
		ui.backups = el('div', { class: 'te-pane' });
		[['colors', 'Colours'], ['element', 'Elements'], ['changed', 'Changes'], ['backups', 'Backups']].forEach(function (t) {
			ui['tab_' + t[0]] = el('button', { type: 'button', class: 'te-tab' + (t[0] === 'colors' ? ' active' : ''), text: t[1], onclick: function () { showTab(t[0]); } });
		});
		var side = el('div', { class: 'te-side' }, [
			el('div', { class: 'te-tabs' }, [ui.tab_colors, ui.tab_element, ui.tab_changed, ui.tab_backups]),
			ui.colors, ui.element, ui.changed, ui.backups,
			el('div', { class: 'te-top', style: 'margin-top:10px' }, [ui.save, ui.note, el('button', { type: 'button', class: 'te-btn ghost', text: 'Close', onclick: close })]),
			ui.msg
		]);
		root.appendChild(el('div', { class: 'te-top' }, [ui.title]));
		root.appendChild(el('p', { class: 'te-hint', text: 'Your changes are kept next to the theme and never touch the original theme file. Each save makes a backup, and the master design can be restored at any time.' }));
		root.appendChild(el('div', { class: 'te-main' }, [ui.stage, side]));
		// Enter in a field must not send the settings form around the editor
		root.addEventListener('keydown', function (e) { if (e.key === 'Enter' && e.target.tagName === 'INPUT') e.preventDefault(); });
		window.addEventListener('resize', fitFrame);
		renderElement();
		renderChanged();
	}

	var built = false;
	function open() {
		if (!built) { build(); built = true; }
		root.classList.add('open');
		openBtn.setAttribute('aria-expanded', 'true');
		fitFrame();
		load(themeSelect.value).then(function () { fitFrame(); loadScreen(); });
	}
	function close() {
		if (dirty() && !confirm('Close the editor and drop the changes you have not saved?')) return;
		if (pickOn) setPick(false);
		root.classList.remove('open');
		openBtn.setAttribute('aria-expanded', 'false');
		ui.frame.src = 'about:blank';
		frameReady = false;
	}
	openBtn.addEventListener('click', function () { if (root.classList.contains('open')) close(); else open(); });
	themeSelect.addEventListener('change', function () {
		if (!root.classList.contains('open')) return;
		if (dirty() && !confirm('You have changes that are not saved. Show the other theme and drop them?')) { themeSelect.value = theme; return; }
		savedJson = modelJson();
		load(themeSelect.value).then(loadScreen);
	});
})();
