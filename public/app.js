const MONTH_NAMES = [
  '', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

let currentMonthData = null;
let editingShiftId = null;

// --- API Helpers ---

async function api(url, options = {}) {
  let res;
  try {
    res = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      ...options
    });
  } catch (networkErr) {
    console.error('Network error:', networkErr);
    throw new Error('Could not connect to server. Is it running?');
  }
  let data;
  try {
    data = await res.json();
  } catch (parseErr) {
    console.error('JSON parse error:', parseErr);
    throw new Error(`Server error (${res.status})`);
  }
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// --- Toast ---

function showToast(message, isError = false) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = 'toast' + (isError ? ' error' : '');
  const delay = isError ? 4000 : 2500;
  setTimeout(() => toast.classList.add('hidden'), delay);
}

// --- Navigation ---

function showView(viewId) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(viewId).classList.add('active');
}

async function showMonthsList() {
  showView('view-months');
  currentMonthData = null;
  editingShiftId = null;
  await loadMonths();
}

// --- Months List ---

async function loadMonths() {
  try {
    const months = await api('/api/months');
    renderMonthsList(months);
  } catch (e) {
    showToast('Failed to load months', true);
  }
}

function renderMonthsList(months) {
  const container = document.getElementById('months-list');

  if (months.length === 0) {
    container.innerHTML = '<p class="empty-state">No months created yet. Click "+ New Month" to get started.</p>';
    return;
  }

  container.innerHTML = months.map(m => {
    const statusClass = m.is_closed ? 'badge-closed' : 'badge-open';
    const statusText = m.is_closed ? 'Closed' : 'Open';
    return `
      <div class="month-item" onclick="openMonth(${m.id})">
        <div class="month-item-info">
          <span class="month-item-name">${MONTH_NAMES[m.month]} ${m.year}</span>
          <span class="badge ${statusClass}">${statusText}</span>
        </div>
        <div class="month-item-meta">
          <button class="btn-icon delete month-item-delete" onclick="event.stopPropagation(); deleteMonth(${m.id}, '${MONTH_NAMES[m.month]} ${m.year}')" title="Delete month">&times;</button>
        </div>
      </div>
    `;
  }).join('');
}

function showNewMonthForm() {
  const form = document.getElementById('new-month-form');
  form.classList.remove('hidden');
  const now = new Date();
  document.getElementById('new-month-select').value = now.getMonth() + 1;
  document.getElementById('new-year-input').value = now.getFullYear();
}

function hideNewMonthForm() {
  document.getElementById('new-month-form').classList.add('hidden');
}

async function createMonth() {
  const month = parseInt(document.getElementById('new-month-select').value);
  const year = parseInt(document.getElementById('new-year-input').value);

  if (!year || year < 2020 || year > 2099) {
    showToast('Please enter a valid year', true);
    return;
  }

  try {
    const newMonth = await api('/api/months', {
      method: 'POST',
      body: JSON.stringify({ month, year })
    });
    hideNewMonthForm();
    showToast(`${MONTH_NAMES[month]} ${year} created`);
    openMonth(newMonth.id);
  } catch (e) {
    showToast(e.message, true);
  }
}

async function deleteMonth(id, name) {
  if (!confirm(`Delete "${name}" and all its shifts? This cannot be undone.`)) return;
  try {
    await api(`/api/months/${id}`, { method: 'DELETE' });
    showToast(`${name} deleted`);
    loadMonths();
  } catch (e) {
    showToast(e.message, true);
  }
}

// --- Month Detail ---

async function openMonth(id) {
  try {
    const data = await api(`/api/months/${id}`);
    currentMonthData = data;
    renderMonthDetail();
    showView('view-month-detail');
  } catch (e) {
    showToast('Failed to load month', true);
  }
}

function renderMonthDetail() {
  const d = currentMonthData;
  const title = `${MONTH_NAMES[d.month]} ${d.year}`;
  document.getElementById('month-detail-title').textContent = title;

  const badge = document.getElementById('month-status-badge');
  const editBtn = document.getElementById('btn-edit-month');
  const shiftForm = document.getElementById('shift-form-container');
  const closeContainer = document.getElementById('close-month-container');
  const colActions = document.getElementById('col-actions');
  const colActionsFoot = document.getElementById('col-actions-foot');

  colActions.classList.remove('hidden');
  colActionsFoot.classList.remove('hidden');

  if (d.is_closed) {
    badge.textContent = 'Closed';
    badge.className = 'badge badge-closed';
    editBtn.classList.remove('hidden');
    shiftForm.classList.add('hidden');
    closeContainer.classList.add('hidden');
  } else {
    badge.textContent = 'Open';
    badge.className = 'badge badge-open';
    editBtn.classList.add('hidden');
    shiftForm.classList.remove('hidden');
    closeContainer.classList.remove('hidden');
    resetShiftForm();
  }

  renderShiftsTable();
}

async function reopenMonth() {
  try {
    await api(`/api/months/${currentMonthData.id}/reopen`, { method: 'PATCH' });
    currentMonthData.is_closed = 0;
    renderMonthDetail();
    showToast('Month reopened for editing');
  } catch (e) {
    showToast(e.message, true);
  }
}

async function closeMonth() {
  const name = `${MONTH_NAMES[currentMonthData.month]} ${currentMonthData.year}`;
  if (!confirm(`Close "${name}"? You can still edit later if needed.`)) return;
  try {
    await api(`/api/months/${currentMonthData.id}/close`, { method: 'PATCH' });
    currentMonthData.is_closed = 1;
    renderMonthDetail();
    showToast(`${name} closed`);
  } catch (e) {
    showToast(e.message, true);
  }
}

// --- Shifts ---

function renderShiftsTable() {
  const shifts = currentMonthData.shifts || [];
  const tbody = document.getElementById('shifts-body');
  const noShiftsMsg = document.getElementById('no-shifts-msg');
  const isEditable = !currentMonthData.is_closed;

  if (shifts.length === 0) {
    tbody.innerHTML = '';
    noShiftsMsg.classList.remove('hidden');
    document.getElementById('total-hours').innerHTML = '<strong>0</strong>';
    document.getElementById('total-earnings').innerHTML = '<strong>0.00 DKK</strong>';
    return;
  }

  noShiftsMsg.classList.add('hidden');

  let totalHours = 0;
  let totalEarnings = 0;

  tbody.innerHTML = shifts.map(s => {
    totalHours += s.total_hours;
    totalEarnings += s.daily_earnings;

    const dateParts = s.date.split('-');
    const displayDate = `${dateParts[2]}/${dateParts[1]}/${dateParts[0]}`;

    const editDeleteHtml = isEditable ? `
          <button class="btn-icon" onclick="editShift(${s.id})" title="Edit">&#9998;</button>
          <button class="btn-icon delete" onclick="deleteShift(${s.id})" title="Delete">&times;</button>
    ` : '';

    return `
      <tr id="shift-row-${s.id}" class="${editingShiftId === s.id ? 'editing' : ''}">
        <td>
          ${displayDate}
          <span class="day-label">${s.day_name}</span>
        </td>
        <td>${s.start_time} – ${s.end_time}</td>
        <td>${s.break_start && s.break_end ? s.break_start + ' – ' + s.break_end : 'None'}</td>
        <td>${s.total_hours.toFixed(2)}</td>
        <td class="earnings-cell">${s.daily_earnings.toFixed(2)}</td>
        <td class="col-actions">
          <div class="actions-cell">
            <button class="btn-icon" onclick="showBreakdown(${s.id})" title="Details">&#9432;</button>
            ${editDeleteHtml}
          </div>
        </td>
      </tr>
    `;
  }).join('');

  document.getElementById('total-hours').innerHTML = `<strong>${totalHours.toFixed(2)}</strong>`;
  document.getElementById('total-earnings').innerHTML = `<strong>${totalEarnings.toFixed(2)} DKK</strong>`;
}

function resetShiftForm() {
  editingShiftId = null;
  document.getElementById('shift-form-title').textContent = 'Add New Shift';
  document.getElementById('btn-save-shift').textContent = 'Add Shift';
  document.getElementById('btn-cancel-edit').classList.add('hidden');
  document.getElementById('shift-date').value = '';
  document.getElementById('shift-start').value = '';
  document.getElementById('shift-end').value = '';
  document.getElementById('shift-break-start').value = '';
  document.getElementById('shift-break-end').value = '';

  setDefaultDate();
}

function setDefaultDate() {
  if (!currentMonthData) return;
  const m = currentMonthData;
  const now = new Date();
  const y = m.year;
  const mo = m.month;

  if (now.getFullYear() === y && (now.getMonth() + 1) === mo) {
    const dd = String(now.getDate()).padStart(2, '0');
    const mm = String(mo).padStart(2, '0');
    document.getElementById('shift-date').value = `${y}-${mm}-${dd}`;
  } else {
    const mm = String(mo).padStart(2, '0');
    document.getElementById('shift-date').value = `${y}-${mm}-01`;
  }
}

function editShift(id) {
  const shift = currentMonthData.shifts.find(s => s.id === id);
  if (!shift) return;

  editingShiftId = id;
  document.getElementById('shift-form-title').textContent = 'Edit Shift';
  document.getElementById('btn-save-shift').textContent = 'Update Shift';
  document.getElementById('btn-cancel-edit').classList.remove('hidden');
  document.getElementById('shift-date').value = shift.date;
  document.getElementById('shift-start').value = shift.start_time;
  document.getElementById('shift-end').value = shift.end_time;
  document.getElementById('shift-break-start').value = shift.break_start || '';
  document.getElementById('shift-break-end').value = shift.break_end || '';

  renderShiftsTable();
  document.getElementById('shift-form-container').scrollIntoView({ behavior: 'smooth' });
}

function cancelEditShift() {
  resetShiftForm();
  renderShiftsTable();
}

async function saveShift() {
  const date = document.getElementById('shift-date').value;
  const startTime = document.getElementById('shift-start').value;
  const endTime = document.getElementById('shift-end').value;
  const breakStart = document.getElementById('shift-break-start').value;
  const breakEnd = document.getElementById('shift-break-end').value;

  if (!date || !startTime || !endTime) {
    showToast('Please fill in date, start and end time', true);
    return;
  }

  if ((breakStart && !breakEnd) || (!breakStart && breakEnd)) {
    showToast('Please fill in both break start and end, or leave both empty', true);
    return;
  }

  const payload = {
    date,
    start_time: startTime,
    end_time: endTime,
    break_start: breakStart || null,
    break_end: breakEnd || null
  };

  try {
    if (editingShiftId) {
      await api(`/api/shifts/${editingShiftId}`, {
        method: 'PUT',
        body: JSON.stringify(payload)
      });
      showToast('Shift updated');
    } else {
      await api(`/api/months/${currentMonthData.id}/shifts`, {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      showToast('Shift added');
    }

    const refreshed = await api(`/api/months/${currentMonthData.id}`);
    currentMonthData = refreshed;
    resetShiftForm();
    renderShiftsTable();
  } catch (e) {
    showToast(e.message, true);
  }
}

async function deleteShift(id) {
  if (!confirm('Delete this shift?')) return;
  try {
    await api(`/api/shifts/${id}`, { method: 'DELETE' });
    const refreshed = await api(`/api/months/${currentMonthData.id}`);
    currentMonthData = refreshed;
    renderShiftsTable();
    showToast('Shift deleted');
  } catch (e) {
    showToast(e.message, true);
  }
}

// --- Breakdown Modal ---

async function showBreakdown(shiftId) {
  try {
    const { shift, breakdown } = await api(`/api/shifts/${shiftId}/breakdown`);
    renderBreakdownModal(shift, breakdown);
  } catch (e) {
    showToast(e.message, true);
  }
}

function renderBreakdownModal(shift, breakdown) {
  const dateParts = shift.date.split('-');
  const displayDate = `${dateParts[2]}/${dateParts[1]}/${dateParts[0]}`;
  const hasBreak = shift.break_start && shift.break_end;

  let segmentsHtml = breakdown.segments.map(seg => {
    if (seg.isBreak) {
      return `
        <tr class="breakdown-break-row">
          <td>${seg.dayName}</td>
          <td>${seg.from} – ${seg.to}</td>
          <td colspan="4" class="breakdown-break-label">BREAK (${seg.minutes} min)</td>
        </tr>
      `;
    }

    const supplementHtml = seg.supplement > 0
      ? `<span class="breakdown-supplement">+${seg.supplement.toFixed(2)}</span>`
      : '<span class="breakdown-no-supplement">none</span>';

    const supplementNameHtml = seg.supplementLabel
      ? `<div class="breakdown-supplement-name">${seg.supplementLabel}</div>`
      : '';

    return `
      <tr>
        <td>${seg.dayName}</td>
        <td>${seg.from} – ${seg.to}</td>
        <td>
          ${seg.baseRate.toFixed(2)} ${supplementHtml}
          ${supplementNameHtml}
        </td>
        <td><strong>${seg.rate.toFixed(2)}</strong> DKK/h</td>
        <td>${seg.hours.toFixed(2)}h</td>
        <td class="earnings-cell">${seg.earnings.toFixed(2)} DKK</td>
      </tr>
    `;
  }).join('');

  const modal = document.getElementById('breakdown-modal');
  const content = document.getElementById('breakdown-content');

  content.innerHTML = `
    <div class="breakdown-header-info">
      <div><strong>Date:</strong> ${displayDate} (${shift.day_name})</div>
      <div><strong>Shift:</strong> ${shift.start_time} – ${shift.end_time}</div>
      ${hasBreak ? `<div><strong>Break:</strong> ${shift.break_start} – ${shift.break_end} (${shift.break_minutes} min)</div>` : '<div><strong>Break:</strong> None</div>'}
    </div>

    <table class="breakdown-table">
      <thead>
        <tr>
          <th>Day</th>
          <th>Time</th>
          <th>Base + Supplement</th>
          <th>Rate</th>
          <th>Hours</th>
          <th>Earnings</th>
        </tr>
      </thead>
      <tbody>
        ${segmentsHtml}
      </tbody>
    </table>

    <div class="breakdown-total">
      <div class="breakdown-total-row">
        <span>Total worked:</span>
        <strong>${breakdown.totalWorkedHours.toFixed(2)} hours</strong>
      </div>
      <div class="breakdown-total-row breakdown-total-earnings">
        <span>Total earnings:</span>
        <strong>${breakdown.totalEarnings.toFixed(2)} DKK</strong>
      </div>
    </div>
  `;

  modal.classList.remove('hidden');
}

function closeBreakdownModal() {
  document.getElementById('breakdown-modal').classList.add('hidden');
}

// --- Init ---

document.addEventListener('DOMContentLoaded', () => {
  loadMonths();

  document.getElementById('breakdown-modal').addEventListener('click', (e) => {
    if (e.target.id === 'breakdown-modal') closeBreakdownModal();
  });
});
