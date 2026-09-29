'use strict';

/* ---------------- 状态与示例 ---------------- */

const SAMPLE = {
  channels: [
    { id: 'R', r: 1000, g: 120, b: 40,  power_mw: 3200 },
    { id: 'G', r: 160,  g: 1000, b: 90, power_mw: 2800 },
    { id: 'B', r: 60,   g: 80,  b: 1000, power_mw: 3400 },
    { id: 'W', r: 820,  g: 800, b: 760, power_mw: 6500 },
  ],
  target: { r: 600, g: 420, b: 180 },
  tolerance: 12,
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const clone = (v) => JSON.parse(JSON.stringify(v));

let channels = clone(SAMPLE.channels);
// 最近一次求解结果（通道满档数据以服务端返回为准）
let solution = null;
// 最优驱动级（id -> drive），供“恢复最优”使用
let optimalDrives = null;
let manualMode = false;

/* ---------------- 工具 ---------------- */

function esc(s) {
  return String(s).replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function intVal(input, fallback = 0) {
  const v = input.value.trim();
  if (v === '' || !/^[+-]?\d+$/.test(v)) return fallback;
  return parseInt(v, 10);
}

// 最多 3 位小数，去掉多余的 0
function fmt(x) {
  const r = Math.round(x * 1000) / 1000;
  return Number.isInteger(r) ? String(r) : r.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}
function fmtSigned(x) { return (x > 0 ? '+' : '') + fmt(x); }

/** 线性 RGB（0～1000 标度）→ sRGB 显示色。仅显示时裁剪到 0～1。 */
function linearToSrgbHex(rgb) {
  const enc = (c) => {
    let v = c / 1000;
    v = Math.min(1, Math.max(0, v)); // 仅显示裁剪
    v = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
    return Math.round(v * 255);
  };
  const h = (n) => n.toString(16).padStart(2, '0');
  return '#' + rgb.map(enc).map(h).join('');
}

function swatchHtml(rgb, title) {
  return `<span class="mini-swatch" style="background:${linearToSrgbHex(rgb)}" title="${esc(title)}"></span>`;
}

function showBanner(kind, html) {
  const el = $('#error-banner');
  el.className = `banner ${kind}`;
  el.innerHTML = html;
}
function clearBanner() { $('#error-banner').className = 'banner error hidden'; }

/* ---------------- 通道录入表 ---------------- */

function renderChannels() {
  const tb = $('#channel-tbody');
  tb.innerHTML = channels.map((ch, i) => `
    <tr data-i="${i}">
      <td class="id-cell"><input type="text" class="f-id" value="${esc(ch.id)}" maxlength="40"></td>
      <td><input type="number" class="f-r" min="0" max="1000" step="1" value="${ch.r}"></td>
      <td><input type="number" class="f-g" min="0" max="1000" step="1" value="${ch.g}"></td>
      <td><input type="number" class="f-b" min="0" max="1000" step="1" value="${ch.b}"></td>
      <td><input type="number" class="f-p" min="1" max="10000" step="1" value="${ch.power_mw}"></td>
      <td class="full-swatch"></td>
      <td><button type="button" class="btn small danger del-btn" ${channels.length <= 3 ? 'disabled' : ''}>删除</button></td>
    </tr>`).join('');
  refreshChannelSwatches();
  $('#add-channel').disabled = channels.length >= 6;
}

function refreshChannelSwatches() {
  $$('#channel-tbody tr').forEach((tr) => {
    const i = +tr.dataset.i;
    const ch = channels[i];
    const cell = tr.querySelector('.full-swatch');
    cell.innerHTML = swatchHtml([ch.r, ch.g, ch.b],
      `满档线性 RGB(${ch.r}, ${ch.g}, ${ch.b})`);
  });
}

function syncRowState(tr) {
  const i = +tr.dataset.i;
  channels[i] = {
    id: tr.querySelector('.f-id').value.trim(),
    r: intVal(tr.querySelector('.f-r')),
    g: intVal(tr.querySelector('.f-g')),
    b: intVal(tr.querySelector('.f-b')),
    power_mw: intVal(tr.querySelector('.f-p')),
  };
  refreshChannelSwatches();
}

function readForm() {
  $$('#channel-tbody tr').forEach((tr) => syncRowState(tr));
  const target = {
    r: intVal($('#target-r')),
    g: intVal($('#target-g')),
    b: intVal($('#target-b')),
  };
  const tolerance = intVal($('#tolerance'));
  return { target, tolerance };
}

function validateForm({ target, tolerance }) {
  const errs = [];
  if (!channels.every((c) => c.id)) errs.push('每路通道都必须填写 ID。');
  const ids = channels.map((c) => c.id);
  const dup = ids.filter((x, i) => x && ids.indexOf(x) !== i);
  if (dup.length) errs.push(`通道 ID 必须唯一，重复：${[...new Set(dup)].join('、')}。`);
  channels.forEach((c) => {
    const tag = c.id ? `“${c.id}”` : '某通道';
    for (const k of ['r', 'g', 'b']) {
      if (!Number.isInteger(c[k]) || c[k] < 0 || c[k] > 1000)
        errs.push(`通道 ${tag} 的满档 ${k.toUpperCase()} 必须是 0～1000 的整数。`);
    }
    if (c.r === 0 && c.g === 0 && c.b === 0)
      errs.push(`通道 ${tag} 的满档 RGB 不能全为零。`);
    if (!Number.isInteger(c.power_mw) || c.power_mw < 1 || c.power_mw > 10000)
      errs.push(`通道 ${tag} 的满档功率必须是 1～10000 mW 的整数。`);
  });
  for (const k of ['r', 'g', 'b']) {
    if (target[k] < 0 || target[k] > 1000)
      errs.push(`目标 ${k.toUpperCase()} 必须是 0～1000 的整数。`);
  }
  if (tolerance < 0 || tolerance > 20) errs.push('共用容差必须是 0～20 的整数。');
  return [...new Set(errs)];
}

/* ---------------- 满档读数标定 ---------------- */

// 样本行：drives 为与 channels 同序的字符串数组（保留原始输入便于校验），
// measured 为实测 R/G/B 字符串
let calibSamples = [];
let calibResult = null;

function syncSamplesFromDom() {
  calibSamples = $$('#sample-tbody tr').map((tr) => ({
    drives: Array.from(tr.querySelectorAll('.f-sd')).map((el) => el.value.trim()),
    measured: ['r', 'g', 'b'].map((k) => tr.querySelector(`.f-sm-${k}`).value.trim()),
  }));
}

function renderSamples() {
  // 注意：不要在这里从 DOM 反向同步——首帧 DOM 为空会清空数据；
  // DOM -> 状态的同步由 syncSamplesFromDom() 在用户操作时显式进行。
  const n = channels.length;
  // 驱动列随当前通道对齐：新增通道补 0，删除通道截掉对应列
  calibSamples.forEach((row) => {
    if (row.drives.length < n) row.drives.push(...Array(n - row.drives.length).fill('0'));
    else if (row.drives.length > n) row.drives = row.drives.slice(0, n);
  });

  const head = $('#sample-thead');
  head.innerHTML = `<tr>
      <th class="idx-cell">#</th>
      ${channels.map((c) => `<th>驱动<span class="hkind hid">${esc(c.id || '？')}</span></th>`).join('')}
      <th>实测 R<span class="hkind">0～6000</span></th>
      <th>实测 G<span class="hkind">0～6000</span></th>
      <th>实测 B<span class="hkind">0～6000</span></th>
      <th></th>
    </tr>`;

  $('#sample-tbody').innerHTML = calibSamples.map((row, j) => `
    <tr data-j="${j}">
      <td class="idx-cell">${j + 1}</td>
      ${row.drives.map((v) => `<td><input type="number" class="f-sd" min="0" max="255" step="1" value="${esc(v)}"></td>`).join('')}
      <td><input type="number" class="f-sm-r" min="0" max="6000" step="1" value="${esc(row.measured[0] ?? '')}"></td>
      <td><input type="number" class="f-sm-g" min="0" max="6000" step="1" value="${esc(row.measured[1] ?? '')}"></td>
      <td><input type="number" class="f-sm-b" min="0" max="6000" step="1" value="${esc(row.measured[2] ?? '')}"></td>
      <td><button type="button" class="btn small danger sample-del" ${calibSamples.length <= 3 ? 'disabled' : ''}>删除</button></td>
    </tr>`).join('');
  $('#add-sample').disabled = calibSamples.length >= 12;
}

// 按当前通道表中的满档 RGB 合成示例样本（对角满档 + 混合驱动）
function generateCalibSamples() {
  const n = channels.length;
  const roundHalfUp = (x) => Math.floor(x + 0.5);
  const measure = (d) => [0, 1, 2].map((c) =>
    roundHalfUp(channels.reduce((s, ch, i) => s + ch[['r', 'g', 'b'][c]] * d[i], 0) / 255));
  const rows = [];
  // n 组对角满档样本：单独把每路开到 255
  for (let i = 0; i < n; i++) {
    const d = Array(n).fill(0);
    d[i] = 255;
    rows.push({ drives: d.map(String), measured: measure(d).map(String) });
  }
  // 补到最多 8 组混合样本
  const mixPresets = [
    [128, 200, 64, 30, 90, 150],
    [100, 100, 100, 100, 100, 100],
    [0, 255, 255, 0, 128, 64],
    [200, 40, 220, 160, 10, 90],
  ];
  for (const preset of mixPresets) {
    if (rows.length >= Math.min(8, 12)) break;
    const d = preset.slice(0, n);
    rows.push({ drives: d.map(String), measured: measure(d).map(String) });
  }
  calibSamples = rows;
  renderSamples();
  invalidateCalib();
}

function invalidateCalib() {
  calibResult = null;
  $('#calib-result').hidden = true;
}

// 初始 4 组样本：与内置 4 路示例通道一一对应（对角满档，量纲自洽）
function seedCalibSamples() {
  const n = channels.length;
  const roundHalfUp = (x) => Math.floor(x + 0.5);
  const measure = (d) => [0, 1, 2].map((c) =>
    roundHalfUp(channels.reduce((s, ch, i) => s + ch[['r', 'g', 'b'][c]] * (d[i] || 0), 0) / 255));
  const presets = [[255, 0, 0, 0], [0, 255, 0, 0], [0, 0, 255, 0], [0, 0, 0, 255]];
  calibSamples = presets.map((p) => {
    const d = p.slice(0, n);
    return { drives: d.map(String), measured: measure(d).map(String) };
  });
}

function validateCalibForm() {
  const errs = [];
  const ids = channels.map((c) => (c.id || '').trim());
  if (ids.some((x) => !x)) errs.push('每路通道都必须填写 ID 后才能标定。');
  else if (new Set(ids).size !== ids.length) {
    const dup = ids.filter((x, i) => ids.indexOf(x) !== i);
    errs.push(`通道 ID 必须唯一，重复：${[...new Set(dup)].join('、')}。`);
  }
  if (!Array.isArray(calibSamples) || calibSamples.length < 3) {
    errs.push('标定至少需要 3 组样本。');
    return errs;
  }
  calibSamples.forEach((row, j) => {
    const tag = `第 ${j + 1} 组样本`;
    if (row.drives.length !== channels.length) {
      errs.push(`${tag} 的驱动级数量与通道数不一致。`);
      return;
    }
    row.drives.forEach((v, i) => {
      if (!/^\d+$/.test(v)) errs.push(`${tag}：通道“${ids[i] || i + 1}”的驱动级必须是 0～255 的整数。`);
      else if (+v > 255) errs.push(`${tag}：通道“${ids[i]}”的驱动级超出 0～255。`);
    });
    (['R', 'G', 'B']).forEach((cn, k) => {
      const v = row.measured[k];
      if (!/^\d+$/.test(v)) errs.push(`${tag}：实测 ${cn} 必须是 0～6000 的整数。`);
      else if (+v > 6000) errs.push(`${tag}：实测 ${cn} 超出 0～6000。`);
    });
  });
  return [...new Set(errs)];
}

async function onCalibrate() {
  clearBanner();
  $$('#channel-tbody tr').forEach((tr) => syncRowState(tr));
  syncSamplesFromDom();
  const errs = validateCalibForm();
  if (errs.length) {
    showBanner('error', '<strong>样本录入有误：</strong><br>' + errs.map(esc).join('<br>'));
    return;
  }
  const btn = $('#calib-btn');
  btn.disabled = true;
  btn.textContent = '标定中…';
  try {
    const resp = await fetch('/api/calibrate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channels: channels.map(({ id }) => ({ id })),
        samples: calibSamples.map((row) => ({
          drives: row.drives.map(Number),
          measured: row.measured.map(Number),
        })),
      }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      const detail = data.detail;
      let msg;
      if (Array.isArray(detail)) {
        msg = detail.map((d) => {
          const loc = (d.loc || []).filter((x) => x !== 'body').join('.');
          return `${loc ? loc + '：' : ''}${d.msg}`;
        }).join('<br>');
      } else {
        msg = esc(String(detail ?? '标定失败'));
      }
      showBanner('error', '<strong>请求被拒绝：</strong><br>' + msg);
      invalidateCalib();
      return;
    }
    calibResult = data;
    renderCalibResult();
  } catch (e) {
    showBanner('error', `请求失败：${esc(e.message)}。请确认后端服务已启动。`);
  } finally {
    btn.disabled = false;
    btn.textContent = '开始标定（整数约束反求）';
  }
}

const CALIB_STATUS_TEXT = {
  unique: '✔ 标定唯一',
  infeasible: '⛔ 样本矛盾',
  non_unique: '⚠ 标定不唯一',
  unknown: '⏳ 搜索未完成',
};

function renderCalibResult() {
  const box = $('#calib-result');
  box.hidden = false;
  const st = calibResult.status;
  let html = `<div class="calib-status ${esc(st)}"><strong>${CALIB_STATUS_TEXT[st] || esc(st)}</strong>：${esc(calibResult.message)}</div>`;
  if (st === 'unique') {
    html += `<div class="table-scroll"><table class="grid" id="calib-out-table"><thead><tr>
        <th>ID</th><th>标定 R</th><th>标定 G</th><th>标定 B</th><th>满档色</th></tr></thead><tbody>
      ${calibResult.channels.map((c) => `<tr data-id="${esc(c.id)}">
        <td><strong>${esc(c.id)}</strong></td>
        <td class="co-r">${c.r}</td><td class="co-g">${c.g}</td><td class="co-b">${c.b}</td>
        <td class="co-swatch"></td></tr>`).join('')}
      </tbody></table></div>
      <div class="writeback-row">
        <button type="button" id="writeback-btn" class="btn primary">一键写回当前通道表（保留原功率）</button>
        <span class="writeback-note">写回后即可在 ③④ 中直接用于配方求解。</span>
      </div>`;
  }
  box.innerHTML = html;
  if (st === 'unique') {
    $$('#calib-out-table tbody tr').forEach((tr) => {
      const c = calibResult.channels.find((x) => x.id === tr.dataset.id);
      tr.querySelector('.co-swatch').innerHTML =
        swatchHtml([c.r, c.g, c.b], `标定满档 RGB(${c.r}, ${c.g}, ${c.b})`);
    });
    $('#writeback-btn').addEventListener('click', writebackCalibration);
  }
}

function writebackCalibration() {
  if (!calibResult || calibResult.status !== 'unique') return;
  const byId = new Map(calibResult.channels.map((c) => [c.id, c]));
  let applied = 0;
  channels.forEach((ch) => {
    const hit = byId.get(ch.id);
    if (hit) {
      ch.r = hit.r; ch.g = hit.g; ch.b = hit.b; // power_mw 原样保留
      applied += 1;
    }
  });
  renderChannels();
  // 旧配方基于旧读数，写回后作废
  solution = null;
  optimalDrives = null;
  $('#result-panel').hidden = true;
  showBanner('info',
    `<strong>已写回 ${applied} 路满档 RGB</strong>（各通道功率保持不变），可直接设置目标并求解配方。`);
}

/* ---------------- 目标色块（实时） ---------------- */

function refreshTargetSwatch() {
  const { target } = readForm();
  const rgb = [target.r, target.g, target.b];
  const hex = linearToSrgbHex(rgb);
  $('#target-swatch').style.background = hex;
  $('#target-swatch').title = `目标线性 RGB(${target.r}, ${target.g}, ${target.b})`;
  $('#target-hex').textContent = hex.toUpperCase();
  if (solution) {
    $('#target-swatch2').style.background = hex;
  }
}

/* ---------------- 求解 ---------------- */

async function onSolve() {
  clearBanner();
  const form = readForm();
  const errs = validateForm(form);
  if (errs.length) {
    showBanner('error', '<strong>录入有误：</strong><br>' + errs.map(esc).join('<br>'));
    return;
  }
  const btn = $('#solve-btn');
  btn.disabled = true;
  btn.textContent = '求解中…';
  try {
    const resp = await fetch('/api/solve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channels: channels.map(({ id, r, g, b, power_mw }) => ({ id, r, g, b, power_mw })),
        target_r: form.target.r,
        target_g: form.target.g,
        target_b: form.target.b,
        tolerance: form.tolerance,
      }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      const detail = data.detail;
      let msg;
      if (Array.isArray(detail)) {
        msg = detail.map((d) => {
          const loc = (d.loc || []).filter((x) => x !== 'body').join('.');
          return `${loc ? loc + '：' : ''}${d.msg}`;
        }).join('<br>');
      } else {
        msg = esc(String(detail ?? '求解失败'));
      }
      showBanner('error', '<strong>请求被拒绝：</strong><br>' + msg);
      return;
    }
    renderSolution(data);
  } catch (e) {
    showBanner('error', `请求失败：${esc(e.message)}。请确认后端服务已启动。`);
  } finally {
    btn.disabled = false;
    btn.textContent = '④ 求解最省功率配方';
  }
}

/* ---------------- 结果渲染与手动预览 ---------------- */

function currentDrives() {
  const drives = {};
  $$('#drive-tbody tr').forEach((tr) => {
    drives[tr.dataset.id] = intVal(tr.querySelector('.f-drive'), 0);
  });
  return drives;
}

function computePreview(drives) {
  const s = [0, 0, 0];
  let powerNum = 0;
  // 与 #drive-tbody 中的行顺序一一对应（渲染顺序与 solution.channels 相同）
  const rows = solution.channels.map((ch) => {
    const d = Math.max(0, Math.min(255, drives[ch.id] ?? 0));
    const full = [ch.r_full, ch.g_full, ch.b_full];
    const contrib = full.map((v) => (v * d) / 255);
    for (let c = 0; c < 3; c++) s[c] += full[c] * d; // 整数分子
    powerNum += ch.power_full_mw * d;
    return { ch, d, contrib };
  });
  const actual = s.map((v) => v / 255);
  return { rows, s, actual, powerNum };
}
function renderSolution(data) {
  solution = data;
  if (!data.feasible) {
    $('#result-panel').hidden = true;
    optimalDrives = null;
    showBanner('info',
      `<strong>⛔ 无可行配方</strong><br>${esc(data.message)}<br>` +
      `<span style="color:var(--muted)">未返回任何近似配方。</span>`);
    return;
  }
  clearBanner();
  $('#result-panel').hidden = false;
  optimalDrives = {};
  data.channels.forEach((c) => { optimalDrives[c.id] = c.drive; });
  manualMode = false;

  $('#drive-tbody').innerHTML = data.channels.map((c) => `
    <tr data-id="${esc(c.id)}">
      <td><strong>${esc(c.id)}</strong></td>
      <td><input type="number" class="f-drive" min="0" max="255" step="1" value="${c.drive}"></td>
      <td class="full-cell"></td>
      <td class="actual-cell"></td>
      <td class="power-cell"></td>
    </tr>`).join('');

  $('#tiebreak-hint').textContent =
    `字典序 tie-break（按 ID 字符串升序）：${data.sorted_ids.map(esc).join(' ＜ ')}`;
  refreshTargetSwatch();
  refreshPreview();
}

function refreshPreview() {
  if (!solution || !solution.feasible) return;
  const drives = currentDrives();
  const { rows, s, actual, powerNum } = computePreview(drives);
  const target = solution.target;
  const tol = solution.tolerance;

  // 驱动表：满档色 / 实际贡献色 / 功率贡献
  const trs = $$('#drive-tbody tr');
  rows.forEach(({ ch, d, contrib }, i) => {
    const tr = trs[i];
    const full = [ch.r_full, ch.g_full, ch.b_full];
    tr.querySelector('.full-cell').innerHTML =
      swatchHtml(full, `${ch.id} 满档 RGB(${full.join(', ')})`);
    tr.querySelector('.actual-cell').innerHTML =
      swatchHtml(contrib, `${ch.id} 驱动 ${d}/255 的线性贡献 RGB(${contrib.map(fmt).join(', ')})`);
    tr.querySelector('.power-cell').textContent =
      fmt((ch.power_full_mw * d) / 255);
  });

  // 实际色块
  const hex = linearToSrgbHex(actual);
  $('#actual-swatch').style.background = hex;
  $('#actual-hex').textContent = hex.toUpperCase();
  const clipped = actual.some((v) => v < 0 || v > 1000);
  $('#actual-swatch').title =
    `实际线性 RGB(${actual.map(fmt).join(', ')})` + (clipped ? '（超出 0～1000，显示已裁剪，模型不裁剪）' : '');

  // 分量对照表
  let allOk = true;
  const names = ['R', 'G', 'B'];
  $$('#component-table tbody tr').forEach((tr) => {
    const c = +tr.dataset.c;
    const lo = target[c] - tol, hi = target[c] + tol;
    const err = actual[c] - target[c];
    const ok = lo <= actual[c] && actual[c] <= hi && 0 <= actual[c] && actual[c] <= 1000;
    if (!ok) allOk = false;
    tr.querySelector('.lo').textContent = Math.max(0, lo);
    tr.querySelector('.tgt').textContent = target[c];
    tr.querySelector('.hi').textContent = Math.min(1000, hi);
    tr.querySelector('.act').innerHTML =
      `<span title="精确值 ${s[c]}/255">${fmt(actual[c])}</span>`;
    tr.querySelector('.err').textContent = fmtSigned(err);
    const j = tr.querySelector('.judge');
    j.textContent = ok ? '✔ 在区间内' : '✘ 超差';
    j.className = 'judge ' + (ok ? 'ok' : 'bad');
  });

  // 功率
  $('#total-power').textContent = fmt(powerNum / 255);
  $('#power-frac').textContent = `精确值 ${powerNum} / 255 mW`;

  // 状态标记
  const tag = $('#power-opt-tag');
  const isOptimal =
    !manualMode &&
    Object.entries(drives).every(([id, d]) => d === optimalDrives[id]);
  if (isOptimal) {
    tag.className = 'tag ok';
    tag.textContent = '最优（最小功率 + 字典序）';
  } else {
    tag.className = 'tag warn';
    tag.textContent = allOk ? '手动预览（仍满足约束）' : '手动预览（已超差，仅供参考）';
  }
  $('#restore-opt').hidden = isOptimal;
  $('#manual-hint').hidden = isOptimal;
}

function restoreOptimal() {
  if (!optimalDrives) return;
  $$('#drive-tbody tr').forEach((tr) => {
    tr.querySelector('.f-drive').value = optimalDrives[tr.dataset.id];
  });
  manualMode = false;
  refreshPreview();
}

/* ---------------- 事件绑定 ---------------- */

function bindEvents() {
  $('#add-channel').addEventListener('click', () => {
    if (channels.length >= 6) return;
    let n = channels.length + 1;
    let id = `LED${n}`;
    const used = new Set(channels.map((c) => c.id));
    while (used.has(id)) { n += 1; id = `LED${n}`; }
    channels.push({ id, r: 500, g: 500, b: 500, power_mw: 3000 });
    renderChannels();
    syncSamplesFromDom();
    renderSamples();
    invalidateCalib();
  });

  $('#reset-sample').addEventListener('click', () => {
    channels = clone(SAMPLE.channels);
    $('#target-r').value = SAMPLE.target.r;
    $('#target-g').value = SAMPLE.target.g;
    $('#target-b').value = SAMPLE.target.b;
    $('#tolerance').value = SAMPLE.tolerance;
    renderChannels();
    calibSamples = [];
    seedCalibSamples();
    renderSamples();
    invalidateCalib();
    refreshTargetSwatch();
    clearBanner();
  });

  $('#channel-tbody').addEventListener('input', (e) => {
    const tr = e.target.closest('tr');
    if (!tr) return;
    syncRowState(tr);
    invalidateCalib();
    // ID 改名时刷新样本表表头的通道名（保留样本已填内容）
    if (e.target.classList.contains('f-id')) {
      syncSamplesFromDom();
      renderSamples();
    }
  });
  $('#channel-tbody').addEventListener('click', (e) => {
    if (!e.target.classList.contains('del-btn')) return;
    const tr = e.target.closest('tr');
    channels.splice(+tr.dataset.i, 1);
    renderChannels();
    syncSamplesFromDom();
    renderSamples();
    invalidateCalib();
  });

  // 标定样本表
  $('#add-sample').addEventListener('click', () => {
    if (calibSamples.length >= 12) return;
    syncSamplesFromDom();
    calibSamples.push({ drives: Array(channels.length).fill('0'), measured: ['', '', ''] });
    renderSamples();
    invalidateCalib();
  });
  $('#calib-sample').addEventListener('click', () => {
    $$('#channel-tbody tr').forEach((tr) => syncRowState(tr));
    generateCalibSamples();
  });
  $('#sample-tbody').addEventListener('click', (e) => {
    if (!e.target.classList.contains('sample-del')) return;
    const tr = e.target.closest('tr');
    syncSamplesFromDom();
    calibSamples.splice(+tr.dataset.j, 1);
    renderSamples();
    invalidateCalib();
  });
  $('#sample-tbody').addEventListener('input', () => invalidateCalib());
  $('#calib-btn').addEventListener('click', onCalibrate);

  ['#target-r', '#target-g', '#target-b', '#tolerance'].forEach((sel) =>
    $(sel).addEventListener('input', refreshTargetSwatch));

  $('#solve-btn').addEventListener('click', onSolve);

  $('#drive-tbody').addEventListener('input', (e) => {
    if (e.target.classList.contains('f-drive')) {
      manualMode = true;
      refreshPreview();
    }
  });
  $('#restore-opt').addEventListener('click', restoreOptimal);
}

/* ---------------- 启动 ---------------- */

renderChannels();
seedCalibSamples();
renderSamples();
refreshTargetSwatch();
bindEvents();
