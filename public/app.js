/* Zonebuddy client — vanilla ES2019 in one file, no build step. */
(function () {
  'use strict';

  var viewEl = document.getElementById('view');
  var contextBar = document.getElementById('context-bar');
  var sessionArea = document.getElementById('session-area');
  var navDashboard = document.getElementById('nav-dashboard');

  var state = {
    user: null,
    sessionChecked: false,
    timeZones: null,
    timers: [],
    planner: null,
  };

  /* ------------------------------------------------------------------ */
  /* API client                                                         */
  /* ------------------------------------------------------------------ */

  function ApiError(status, payload) {
    var message = (payload && payload.error) || 'Request failed (' + status + ')';
    var error = new Error(message);
    error.name = 'ApiError';
    error.status = status;
    error.payload = payload || {};
    return error;
  }

  async function api(path, options) {
    var opts = options || {};
    var init = {
      method: opts.method || 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    };
    if (opts.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    var response;
    try {
      response = await fetch(path, init);
    } catch (cause) {
      throw ApiError(0, { error: 'Cannot reach the server. Check your connection and try again.' });
    }
    var text = await response.text();
    var payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch (cause) {
        payload = null;
      }
    }
    if (response.status === 401 && path.indexOf('/api/auth/') !== 0) {
      handleExpiredSession();
    }
    if (!response.ok) throw ApiError(response.status, payload);
    return payload || {};
  }

  function handleExpiredSession() {
    if (!state.user) return;
    state.user = null;
    state.sessionChecked = true;
    updateSessionArea();
    var target = window.location.pathname + window.location.search;
    navigate('/login?expired=1&next=' + encodeURIComponent(target), { replace: true });
  }

  /* ------------------------------------------------------------------ */
  /* DOM helpers                                                        */
  /* ------------------------------------------------------------------ */

  function h(tag, attrs) {
    var node = document.createElement(tag);
    var extra = Array.prototype.slice.call(arguments, 2);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        var value = attrs[key];
        if (value === undefined || value === null || value === false) return;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = String(value);
        else if (key === 'dataset') Object.keys(value).forEach(function (dataKey) { node.dataset[dataKey] = value[dataKey]; });
        else if (key === 'style') Object.keys(value).forEach(function (styleKey) { node.style[styleKey] = value[styleKey]; });
        else if (key.slice(0, 2) === 'on' && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
        else if (value === true) node.setAttribute(key, '');
        else node.setAttribute(key, String(value));
      });
    }
    appendChildren(node, extra);
    return node;
  }

  function appendChildren(node, children) {
    children.forEach(function (child) {
      if (child === null || child === undefined || child === false) return;
      if (Array.isArray(child)) {
        appendChildren(node, child);
        return;
      }
      node.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
    });
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function showContextBar() {
    var children = Array.prototype.slice.call(arguments);
    clear(contextBar);
    var inner = h('div', { class: 'context-inner' });
    appendChildren(inner, children);
    contextBar.appendChild(inner);
    contextBar.hidden = false;
  }

  function hideContextBar() {
    clear(contextBar);
    contextBar.hidden = true;
  }

  function clearTimers() {
    state.timers.forEach(function (id) { window.clearInterval(id); });
    state.timers = [];
  }

  function addTimer(id) {
    state.timers.push(id);
  }

  /* ------------------------------------------------------------------ */
  /* Time-zone helpers (mirror the server's Intl-based math)            */
  /* ------------------------------------------------------------------ */

  var TZ_UTILS = (function () {
    var formatters = new Map();

    function formatter(zone) {
      var cached = formatters.get(zone);
      if (!cached) {
        cached = new Intl.DateTimeFormat('en-US', {
          timeZone: zone,
          hourCycle: 'h23',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        });
        formatters.set(zone, cached);
      }
      return cached;
    }

    function parts(zone, instantMs) {
      var out = {};
      formatter(zone).formatToParts(new Date(instantMs)).forEach(function (part) {
        if (part.type !== 'literal') out[part.type] = Number(part.value);
      });
      return out;
    }

    function offsetMs(zone, instantMs) {
      var p = parts(zone, instantMs);
      var asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
      return asUtc - Math.floor(instantMs / 1000) * 1000;
    }

    function pad2(value) { return String(value).padStart(2, '0'); }

    function minutesOfDay(zone, instantMs) {
      var p = parts(zone, instantMs);
      return p.hour * 60 + p.minute;
    }

    function dateKey(zone, instantMs) {
      var p = parts(zone, instantMs);
      return p.year + '-' + pad2(p.month) + '-' + pad2(p.day);
    }

    function zonedToUtc(dateStr, minutes, zone) {
      var bits = dateStr.split('-').map(Number);
      var naive = Date.UTC(bits[0], bits[1] - 1, bits[2], 0, 0, 0) + minutes * 60000;
      var first = offsetMs(zone, naive);
      var utc = naive - first;
      var second = offsetMs(zone, utc);
      if (second !== first) utc = naive - second;
      return utc;
    }

    function addDays(dateStr, days) {
      var bits = dateStr.split('-').map(Number);
      var shifted = new Date(Date.UTC(bits[0], bits[1] - 1, bits[2]) + days * 86400000);
      return shifted.getUTCFullYear() + '-' + pad2(shifted.getUTCMonth() + 1) + '-' + pad2(shifted.getUTCDate());
    }

    function weekday(dateStr) {
      var bits = dateStr.split('-').map(Number);
      return new Date(Date.UTC(bits[0], bits[1] - 1, bits[2])).getUTCDay();
    }

    function mondayOf(dateStr) {
      return addDays(dateStr, -((weekday(dateStr) + 6) % 7));
    }

    function hhmmToMinutes(value) {
      var bits = String(value).split(':').map(Number);
      return bits[0] * 60 + bits[1];
    }

    function minutesToHHMM(total) {
      var normalized = ((total % 1440) + 1440) % 1440;
      return pad2(Math.floor(normalized / 60)) + ':' + pad2(normalized % 60);
    }

    function timeLabel(zone, instantMs) {
      return minutesToHHMM(minutesOfDay(zone, instantMs));
    }

    function dayLabel(zone, instantMs) {
      return new Intl.DateTimeFormat('en-GB', {
        weekday: 'short', day: 'numeric', month: 'short', timeZone: zone,
      }).format(new Date(instantMs));
    }

    function shortDay(zone, instantMs) {
      return new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: zone }).format(new Date(instantMs));
    }

    function dateLabel(zone, instantMs) {
      return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: zone }).format(new Date(instantMs));
    }

    function zoneAbbr(zone, instantMs) {
      try {
        var formatted = new Intl.DateTimeFormat('en-GB', { timeZone: zone, timeZoneName: 'shortOffset' }).formatToParts(
          new Date(instantMs || Date.now()),
        );
        var found = formatted.find(function (part) { return part.type === 'timeZoneName'; });
        return found ? found.value : '';
      } catch (error) {
        return '';
      }
    }

    /** UTC intervals where the member is inside their working hours. */
    function workingIntervals(member, windowStart, windowEnd) {
      var workStart = hhmmToMinutes(member.workStart);
      var workEnd = hhmmToMinutes(member.workEnd);
      if (workEnd <= workStart) return [];
      var startDate = dateKey(member.timeZone, windowStart);
      var endDate = dateKey(member.timeZone, windowEnd);
      var dates = [addDays(startDate, -1), startDate, endDate, addDays(endDate, 1)];
      var intervals = [];
      dates.forEach(function (localDate) {
        var start = zonedToUtc(localDate, workStart, member.timeZone);
        var end = zonedToUtc(localDate, workEnd, member.timeZone);
        if (end > start) intervals.push([start, end]);
      });
      return intervals;
    }

    return {
      minutesOfDay: minutesOfDay,
      dateKey: dateKey,
      zonedToUtc: zonedToUtc,
      addDays: addDays,
      mondayOf: mondayOf,
      timeLabel: timeLabel,
      dayLabel: dayLabel,
      shortDay: shortDay,
      dateLabel: dateLabel,
      zoneAbbr: zoneAbbr,
      workingIntervals: workingIntervals,
    };
  })();

  function relativeTime(iso) {
    var then = Date.parse(iso || '');
    if (!Number.isFinite(then)) return '';
    var diffMinutes = Math.round((Date.now() - then) / 60000);
    if (diffMinutes < 0) {
      var ahead = Math.abs(diffMinutes);
      if (ahead < 60) return 'in ' + ahead + ' min';
      if (ahead < 1440) return 'in ' + Math.round(ahead / 60) + ' h';
      return 'in ' + Math.round(ahead / 1440) + ' days';
    }
    if (diffMinutes < 1) return 'just now';
    if (diffMinutes < 60) return diffMinutes + ' min ago';
    var hours = Math.round(diffMinutes / 60);
    if (hours < 24) return hours + ' h ago';
    var days = Math.round(hours / 24);
    if (days === 1) return 'yesterday';
    if (days < 7) return days + ' days ago';
    return new Date(then).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }

  var SWATCH_CLASSES = {
    '#528A54': 'swatch-1',
    '#0072B2': 'swatch-2',
    '#D55E00': 'swatch-3',
    '#009E73': 'swatch-4',
    '#CC79A7': 'swatch-5',
    '#E69F00': 'swatch-6',
  };

  var SERIES_CLASSES = {
    '#528A54': 's1',
    '#0072B2': 's2',
    '#D55E00': 's3',
    '#009E73': 's4',
    '#CC79A7': 's5',
    '#E69F00': 's6',
  };

  function swatchClass(color) {
    return SWATCH_CLASSES[String(color || '').toUpperCase()] || 'swatch-1';
  }

  function seriesClass(color) {
    return SERIES_CLASSES[String(color || '').toUpperCase()] || 's1';
  }

  /* ------------------------------------------------------------------ */
  /* Session + shell chrome                                             */
  /* ------------------------------------------------------------------ */

  async function ensureSession(force) {
    if (state.sessionChecked && !force) return state.user;
    try {
      var data = await api('/api/auth/me');
      state.user = data.user || null;
    } catch (error) {
      if (error.status && error.status !== 401) console.error('session check failed', error);
      state.user = null;
    }
    state.sessionChecked = true;
    return state.user;
  }

  function updateSessionArea() {
    clear(sessionArea);
    if (state.user) {
      sessionArea.appendChild(h('span', { class: 'session-user' }, h('strong', { text: state.user.email })));
      var logout = h('button', { class: 'btn btn-quiet btn-sm', type: 'button', text: 'Sign out' });
      logout.addEventListener('click', async function () {
        logout.disabled = true;
        try {
          await api('/api/auth/logout', { method: 'POST' });
        } catch (error) {
          console.error('logout failed', error);
        }
        state.user = null;
        state.timeZones = null;
        updateSessionArea();
        navigate('/login', { replace: true });
      });
      sessionArea.appendChild(logout);
      navDashboard.hidden = false;
    } else {
      sessionArea.appendChild(h('a', { class: 'btn btn-quiet btn-sm', href: '/login', text: 'Sign in' }));
      sessionArea.appendChild(h('a', { class: 'btn btn-primary btn-sm', href: '/signup', text: 'Create account' }));
      navDashboard.hidden = true;
    }
  }

  function updateNav(pathname) {
    var isDashboard = pathname === '/app';
    if (isDashboard) navDashboard.setAttribute('aria-current', 'page');
    else navDashboard.removeAttribute('aria-current');
  }

  /* ------------------------------------------------------------------ */
  /* Router                                                             */
  /* ------------------------------------------------------------------ */

  var ROUTES = [
    { pattern: /^\/login$/, render: function () { return renderLogin(); }, title: 'Sign in', guest: true },
    { pattern: /^\/signup$/, render: function () { return renderSignup(); }, title: 'Create account', guest: true },
    { pattern: /^\/app$/, render: function () { return renderDashboard(); }, title: 'Dashboard', auth: true },
    { pattern: /^\/app\/teams\/([^/]+)$/, render: function (p) { return renderPlanner(p[0]); }, title: 'Team planner', auth: true },
    { pattern: /^\/share\/([^/]+)$/, render: function (p) { return renderShare(p[0]); }, title: 'Shared plan' },
    {
      pattern: /^\/$/,
      render: function () {
        navigate(state.user ? '/app' : '/login', { replace: true });
      },
      title: 'Meeting Time Planner',
    },
  ];

  function matchRoute(pathname) {
    for (var index = 0; index < ROUTES.length; index += 1) {
      var match = pathname.match(ROUTES[index].pattern);
      if (match) return { route: ROUTES[index], params: match.slice(1) };
    }
    return null;
  }

  function navigate(to, options) {
    var opts = options || {};
    var target = new URL(to, window.location.origin);
    var nextPath = target.pathname + target.search;
    if (opts.replace) window.history.replaceState({}, '', nextPath);
    else window.history.pushState({}, '', nextPath);
    renderRoute();
  }

  window.addEventListener('popstate', function () { renderRoute(); });

  document.addEventListener('click', function (event) {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    var anchor = event.target.closest ? event.target.closest('a[href]') : null;
    if (!anchor) return;
    var href = anchor.getAttribute('href');
    if (!href || href.charAt(0) !== '/') return;
    if (anchor.target && anchor.target !== '_self') return;
    event.preventDefault();
    navigate(href);
  });

  async function renderRoute() {
    clearTimers();
    hideContextBar();
    var pathname = window.location.pathname;
    var matched = matchRoute(pathname);
    var user = await ensureSession();
    updateSessionArea();
    updateNav(pathname);

    if (!matched) {
      document.title = 'Page not found · Zonebuddy';
      renderNotFound();
      return;
    }

    if (matched.route.auth && !user) {
      var next = encodeURIComponent(pathname + window.location.search);
      navigate('/login?next=' + next, { replace: true });
      return;
    }
    if (matched.route.guest && user) {
      navigate('/app', { replace: true });
      return;
    }

    document.title = matched.route.title + ' · Zonebuddy';
    try {
      await matched.route.render(matched.params);
    } catch (error) {
      console.error('route render failed', error);
      renderRouteError(error, function () { renderRoute(); });
    }
    // Move focus to the content region on client-side navigation so keyboard and
    // screen-reader users start at the new page, not on a link that no longer exists.
    if (state.renderedOnce) {
      var mainElement = document.getElementById('main');
      if (mainElement) mainElement.focus();
    }
    state.renderedOnce = true;
  }

  function renderRouteError(error, retry) {
    var panel = h('div', { class: 'error-state', role: 'alert' },
      h('p', { text: error && error.status === 0 ? 'Cannot reach the server. Check your connection and try again.' : 'Something went wrong loading this page.' }),
      h('button', { class: 'btn btn-secondary btn-sm', type: 'button', text: 'Retry', onclick: retry }),
    );
    clear(viewEl);
    viewEl.appendChild(h('div', { class: 'view-header' }, h('h1', { text: 'Zonebuddy' })));
    viewEl.appendChild(panel);
  }

  function renderNotFound() {
    clear(viewEl);
    var body = h('div', { class: 'not-found' },
      h('h1', { text: 'That page does not exist' }),
      h('p', { text: 'The link may be old, or the team or plan may have been deleted.' }),
      h('div', { class: 'btn-group' },
        h('a', { class: 'btn btn-primary', href: state.user ? '/app' : '/login', text: state.user ? 'Back to dashboard' : 'Go to sign in' }),
      ),
    );
    viewEl.appendChild(body);
  }

  function loadTimeZones() {
    if (state.timeZones) return Promise.resolve(state.timeZones);
    return api('/api/timezones')
      .then(function (data) {
        state.timeZones = data.timeZones || [];
        return state.timeZones;
      })
      .catch(function (error) {
        if (error.status === 401 || error.status === 0) {
          state.timeZones = browserTimeZones();
          return state.timeZones;
        }
        throw error;
      });
  }

  function browserTimeZones() {
    try {
      if (typeof Intl.supportedValuesOf === 'function') {
        var zones = Intl.supportedValuesOf('timeZone');
        if (zones && zones.length) return zones;
      }
    } catch (error) {
      console.warn('Intl.supportedValuesOf unavailable', error);
    }
    return ['UTC', 'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'Europe/London', 'Europe/Berlin', 'Asia/Kolkata', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney'];
  }

  function fillDatalist(datalist, zones) {
    clear(datalist);
    var fragment = document.createDocumentFragment();
    zones.forEach(function (zone) {
      var option = document.createElement('option');
      option.value = zone;
      fragment.appendChild(option);
    });
    datalist.appendChild(fragment);
  }

  function setFieldErrors(container, errors, fields) {
    clear(container);
    var messages = [];
    fields.forEach(function (field) {
      var input = document.getElementById(field.inputId);
      var target = document.getElementById(field.errorId);
      var message = errors && errors[field.key];
      if (target) target.textContent = message || '';
      if (input && message) input.setAttribute('aria-invalid', 'true');
      else if (input) input.removeAttribute('aria-invalid');
      if (message) messages.push(message);
    });
    if (container.textContent.trim() === '' && messages.length) container.textContent = messages[0];
  }

  function busy(button, isBusy, busyLabel) {
    if (!button) return;
    if (isBusy) {
      button.dataset.label = button.textContent;
      button.textContent = busyLabel || 'Working…';
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
    } else {
      if (button.dataset.label) button.textContent = button.dataset.label;
      delete button.dataset.label;
      button.disabled = false;
      button.removeAttribute('aria-busy');
    }
  }

  /* ------------------------------------------------------------------ */
  /* Auth screens (built with DOM APIs — no HTML string sinks)          */
  /* ------------------------------------------------------------------ */

  function safeNextPath(raw) {
    if (!raw) return '';
    if (raw.charAt(0) !== '/') return '';
    if (raw.slice(0, 2) === '//') return '';
    return raw;
  }

  function demoCredentialsLine() {
    return h('p', { class: 'demo-creds' },
      h('span', { text: 'Demo: ' }),
      h('code', { text: 'cenius@cenius.ai' }),
      h('span', { text: ' / ' }),
      h('code', { text: 'cenius' }),
    );
  }

  function asideItem(marker, titleText, bodyText) {
    return h('li', null,
      h('span', { class: 'aside-icon', 'aria-hidden': 'true', text: marker }),
      h('span', null,
        h('strong', { text: titleText }),
        h('span', { text: ' ' + bodyText }),
      ),
    );
  }

  function buildPreview() {
    var miniGrid = h('div', { class: 'mini-grid', id: 'mini-grid' });
    var pattern = [0, 0, 1, 2, 3, 3, 2, 1, 1, 0, 0, 0, 0, 0, 1, 1, 2, 3, 4, 3, 2, 1, 0, 0];
    for (var index = 0; index < 60; index += 1) {
      var level = index < 48 ? pattern[index % pattern.length] : 0;
      miniGrid.appendChild(h('div', { class: 'mini-cell' + (level > 1 ? ' l' + level : '') }));
    }
    return h('div', { class: 'aside-preview', 'aria-hidden': 'true' },
      h('div', { class: 'aside-preview-head' },
        h('span', { text: 'Overlap \u00b7 Europe/Berlin' }),
        h('span', { text: 'Mon\u2013Fri' }),
      ),
      miniGrid,
    );
  }

  function renderLogin() {
    var params = new URLSearchParams(window.location.search);
    var next = safeNextPath(params.get('next') || '');
    var expired = params.get('expired') === '1';

    var emailInput = h('input', {
      id: 'login-email', name: 'email', type: 'text', autocomplete: 'username',
      inputmode: 'email', spellcheck: 'false', required: true,
    });
    var passwordInput = h('input', {
      id: 'login-password', name: 'password', type: 'password', autocomplete: 'current-password', required: true,
    });
    var emailError = h('p', { class: 'field-error', id: 'login-email-error', role: 'alert' });
    var passwordError = h('p', { class: 'field-error', id: 'login-password-error', role: 'alert' });
    var errorBox = h('div', { class: 'form-errors', id: 'login-error', role: 'alert', 'aria-live': 'polite' });
    var toggle = h('button', {
      class: 'btn btn-secondary', type: 'button', id: 'toggle-password',
      'aria-pressed': 'false', 'aria-label': 'Show password', text: 'Show',
    });
    var submitButton = h('button', {
      class: 'btn btn-primary btn-block', type: 'submit', id: 'login-submit', text: 'Sign in',
    });

    var form = h('form', { class: 'auth-form', id: 'login-form', novalidate: true },
      h('div', { class: 'field' },
        h('label', { for: 'login-email', text: 'Email' }),
        emailInput,
        emailError,
      ),
      h('div', { class: 'field' },
        h('label', { for: 'login-password', text: 'Password' }),
        h('div', { class: 'field-inline' }, passwordInput, toggle),
        passwordError,
      ),
      errorBox,
      submitButton,
    );

    var demoFill = h('button', {
      class: 'btn btn-secondary btn-block', type: 'button', id: 'demo-fill', text: 'Fill demo credentials',
    });

    var card = h('section', { class: 'auth-card', 'aria-labelledby': 'login-title' },
      h('h1', { id: 'login-title', text: 'Sign in to Zonebuddy' }),
      h('p', {
        class: 'auth-lede',
        text: 'See where your distributed team\u2019s working hours overlap, then lock a meeting slot that suits everyone.',
      }),
      form,
      h('div', { class: 'demo-card' },
        h('p', { class: 'demo-label', text: 'Demo account' }),
        demoCredentialsLine(),
        demoFill,
        h('p', { class: 'demo-note', text: 'Second seeded account: demo@zonebuddy.dev / zonebuddy123' }),
      ),
      h('p', { class: 'auth-switch' },
        h('span', { text: 'New to Zonebuddy? ' }),
        h('a', { href: '/signup', text: 'Create an account' }),
      ),
    );

    var aside = h('aside', { class: 'auth-aside', 'aria-label': 'About Zonebuddy' },
      h('p', { class: 'aside-title', text: 'Why teams pick Zonebuddy' }),
      h('ul', { class: 'aside-list' },
        asideItem('1', 'Map the overlap.', 'A 7 \u00d7 24-hour grid shades each member\u2019s working hours in a reference zone you choose.'),
        asideItem('2', 'Rank the slots.', 'Zonebuddy computes the times every member is inside working hours and ranks the most comfortable.'),
        asideItem('3', 'Share the plan.', 'Send a read-only link \u2014 nobody needs an account to read the grid.'),
      ),
      buildPreview(),
      h('p', { class: 'auth-footnote', text: 'Runs entirely on this server: no third-party accounts, no outbound requests.' }),
    );

    clear(viewEl);
    viewEl.appendChild(h('div', { class: 'auth-layout' }, card, aside));

    toggle.addEventListener('click', function () {
      var showing = passwordInput.getAttribute('type') === 'text';
      passwordInput.setAttribute('type', showing ? 'password' : 'text');
      toggle.textContent = showing ? 'Show' : 'Hide';
      toggle.setAttribute('aria-pressed', showing ? 'false' : 'true');
      toggle.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
      passwordInput.focus();
    });

    demoFill.addEventListener('click', function () {
      emailInput.value = 'cenius@cenius.ai';
      passwordInput.value = 'cenius';
      emailError.textContent = '';
      passwordError.textContent = '';
      errorBox.textContent = '';
      submitButton.focus();
    });

    if (expired) {
      errorBox.textContent = 'Your session expired. Sign in again to continue where you left off.';
    }

    emailInput.focus();

    form.addEventListener('submit', async function (event) {
      event.preventDefault();
      if (form.dataset.busy === 'true') return;

      var email = emailInput.value.trim();
      var password = passwordInput.value;
      var fieldErrors = { email: '', password: '' };
      if (!email) fieldErrors.email = 'Enter your email address.';
      if (!password) fieldErrors.password = 'Enter your password.';
      setFieldErrors(errorBox, fieldErrors, [
        { key: 'email', inputId: 'login-email', errorId: 'login-email-error' },
        { key: 'password', inputId: 'login-password', errorId: 'login-password-error' },
      ]);
      if (fieldErrors.email || fieldErrors.password) {
        (fieldErrors.email ? emailInput : passwordInput).focus();
        return;
      }

      form.dataset.busy = 'true';
      busy(submitButton, true, 'Signing in…');
      errorBox.textContent = '';
      try {
        var data = await api('/api/auth/login', { method: 'POST', body: { email: email, password: password } });
        state.user = data.user;
        state.sessionChecked = true;
        updateSessionArea();
        navigate(next || '/app', { replace: true });
      } catch (error) {
        errorBox.textContent = error.message || 'Sign-in failed. Try again.';
        if (error.payload && error.payload.errors) {
          setFieldErrors(errorBox, error.payload.errors, [
            { key: 'email', inputId: 'login-email', errorId: 'login-email-error' },
            { key: 'password', inputId: 'login-password', errorId: 'login-password-error' },
          ]);
        }
        passwordInput.focus();
        passwordInput.select();
      } finally {
        form.dataset.busy = 'false';
        busy(submitButton, false);
      }
    });
  }

  function renderSignup() {
    var emailInput = h('input', {
      id: 'signup-email', name: 'email', type: 'email', autocomplete: 'username',
      inputmode: 'email', spellcheck: 'false', required: true,
    });
    var passwordInput = h('input', {
      id: 'signup-password', name: 'password', type: 'password', autocomplete: 'new-password',
      required: true, 'aria-describedby': 'signup-password-hint',
    });
    var confirmInput = h('input', {
      id: 'signup-confirm', name: 'confirmPassword', type: 'password', autocomplete: 'new-password', required: true,
    });
    var toggle = h('button', {
      class: 'btn btn-secondary', type: 'button', id: 'signup-toggle',
      'aria-pressed': 'false', 'aria-label': 'Show password', text: 'Show',
    });
    var submitButton = h('button', {
      class: 'btn btn-primary btn-block', type: 'submit', id: 'signup-submit', text: 'Create account',
    });
    var errorBox = h('div', { class: 'form-errors', id: 'signup-error', role: 'alert', 'aria-live': 'polite' });

    var form = h('form', { class: 'auth-form', id: 'signup-form', novalidate: true },
      h('div', { class: 'field' },
        h('label', { for: 'signup-email', text: 'Email' }),
        emailInput,
        h('p', { class: 'field-error', id: 'signup-email-error', role: 'alert' }),
      ),
      h('div', { class: 'field' },
        h('label', { for: 'signup-password', text: 'Password' }),
        h('div', { class: 'field-inline' }, passwordInput, toggle),
        h('p', { class: 'hint', id: 'signup-password-hint', text: 'At least 8 characters. Any mix of letters, numbers and symbols.' }),
        h('p', { class: 'field-error', id: 'signup-password-error', role: 'alert' }),
      ),
      h('div', { class: 'field' },
        h('label', { for: 'signup-confirm', text: 'Confirm password' }),
        confirmInput,
        h('p', { class: 'field-error', id: 'signup-confirm-error', role: 'alert' }),
      ),
      errorBox,
      submitButton,
    );

    var card = h('section', { class: 'auth-card', 'aria-labelledby': 'signup-title' },
      h('h1', { id: 'signup-title', text: 'Create your Zonebuddy account' }),
      h('p', {
        class: 'auth-lede',
        text: 'Your teams, members and share links stay on this server. Passwords are stored as salted scrypt hashes.',
      }),
      form,
      h('p', { class: 'auth-switch' },
        h('span', { text: 'Already have an account? ' }),
        h('a', { href: '/login', text: 'Sign in' }),
      ),
    );

    var aside = h('aside', { class: 'auth-aside', 'aria-label': 'What happens next' },
      h('p', { class: 'aside-title', text: 'What you get' }),
      h('ul', { class: 'aside-list' },
        asideItem('\u2713', 'A populated dashboard.', 'Every team shows its real shared window this week.'),
        asideItem('\u2713', 'Member-level hours.', 'Any IANA time zone, including half-hour offsets like Asia/Kolkata.'),
        asideItem('\u2713', 'Shareable plans.', 'Ranked meeting slots per day plus a read-only link you can paste into chat.'),
      ),
      h('p', { class: 'auth-footnote' },
        h('span', { text: 'Prefer to look around first? Sign in with the seeded demo account on the ' }),
        h('a', { href: '/login', text: 'sign-in page' }),
        h('span', { text: '.' }),
      ),
    );

    clear(viewEl);
    viewEl.appendChild(h('div', { class: 'auth-layout' }, card, aside));

    var fields = [
      { key: 'email', inputId: 'signup-email', errorId: 'signup-email-error' },
      { key: 'password', inputId: 'signup-password', errorId: 'signup-password-error' },
      { key: 'confirmPassword', inputId: 'signup-confirm', errorId: 'signup-confirm-error' },
    ];

    toggle.addEventListener('click', function () {
      var showing = passwordInput.getAttribute('type') === 'text';
      passwordInput.setAttribute('type', showing ? 'password' : 'text');
      toggle.textContent = showing ? 'Show' : 'Hide';
      toggle.setAttribute('aria-pressed', showing ? 'false' : 'true');
      toggle.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
    });

    emailInput.focus();

    form.addEventListener('submit', async function (event) {
      event.preventDefault();
      if (form.dataset.busy === 'true') return;

      var email = emailInput.value.trim();
      var password = passwordInput.value;
      var confirm = confirmInput.value;
      var clientErrors = { email: '', password: '', confirmPassword: '' };
      if (!email) clientErrors.email = 'Enter your email address.';
      else if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) clientErrors.email = 'Enter a valid email address, like name@team.com.';
      if (!password) clientErrors.password = 'Choose a password.';
      else if (password.length < 8) clientErrors.password = 'Use at least 8 characters.';
      if (!confirm) clientErrors.confirmPassword = 'Repeat your password.';
      else if (confirm !== password) clientErrors.confirmPassword = 'The passwords do not match.';

      setFieldErrors(errorBox, clientErrors, fields);
      if (clientErrors.email || clientErrors.password || clientErrors.confirmPassword) {
        if (clientErrors.email) emailInput.focus();
        else if (clientErrors.password) passwordInput.focus();
        else confirmInput.focus();
        return;
      }

      form.dataset.busy = 'true';
      busy(submitButton, true, 'Creating account…');
      errorBox.textContent = '';
      try {
        var data = await api('/api/auth/signup', {
          method: 'POST',
          body: { email: email, password: password, confirmPassword: confirm },
        });
        state.user = data.user;
        state.sessionChecked = true;
        updateSessionArea();
        navigate('/app', { replace: true });
      } catch (error) {
        errorBox.textContent = error.payload && error.payload.error ? error.payload.error : 'Could not create the account.';
        if (error.payload && error.payload.errors) setFieldErrors(errorBox, error.payload.errors, fields);
      } finally {
        form.dataset.busy = 'false';
        busy(submitButton, false);
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /* Dashboard                                                          */
  /* ------------------------------------------------------------------ */

  function buildSpark(hours) {
    var spark = h('span', { class: 'spark', 'aria-hidden': 'true' });
    (hours || []).forEach(function (value) {
      var height = Math.max(2, Math.round((Math.min(value, 12) / 12) * 16));
      var bar = h('span', { class: 'spark-bar' + (value ? '' : ' is-zero') });
      bar.style.height = height + 'px';
      spark.appendChild(bar);
    });
    return spark;
  }

  function weekdayAverage(hours) {
    if (!hours || !hours.length) return 0;
    var weekdays = hours.slice(0, 5);
    var total = weekdays.reduce(function (sum, value) { return sum + value; }, 0);
    return Math.round((total / weekdays.length) * 10) / 10;
  }

  function dashboardCreateForm(onCreated) {
    var input = h('input', {
      id: 'new-team-name',
      name: 'name',
      type: 'text',
      maxlength: '80',
      placeholder: 'e.g. Launch planning',
      autocomplete: 'off',
      required: true,
    });
    var button = h('button', { class: 'btn btn-primary', type: 'submit', id: 'create-team-submit', text: 'Create team' });
    var errorEl = h('p', { class: 'field-error', role: 'alert', id: 'create-team-error' });
    var form = h(
      'form',
      { class: 'dash-create', id: 'create-team-form', novalidate: true },
      h('div', { class: 'field' }, h('label', { for: 'new-team-name', text: 'New team' }), input),
      button,
      errorEl,
    );

    form.addEventListener('submit', async function (event) {
      event.preventDefault();
      if (form.dataset.busy === 'true') return;
      var name = input.value.trim();
      errorEl.textContent = '';
      input.removeAttribute('aria-invalid');
      if (!name) {
        errorEl.textContent = 'Give the team a name.';
        input.setAttribute('aria-invalid', 'true');
        input.focus();
        return;
      }
      form.dataset.busy = 'true';
      busy(button, true, 'Creating…');
      try {
        var data = await api('/api/teams', { method: 'POST', body: { name: name } });
        input.value = '';
        if (onCreated) await onCreated(data.team);
      } catch (error) {
        errorEl.textContent = (error.payload && error.payload.errors && error.payload.errors.name) || error.message;
        input.setAttribute('aria-invalid', 'true');
      } finally {
        form.dataset.busy = 'false';
        busy(button, false);
      }
    });

    return { form: form, input: input };
  }

  function renderDashboardLoading() {
    clear(viewEl);
    viewEl.appendChild(
      h('div', { class: 'view-header' }, h('h1', { text: 'Dashboard' })),
    );
    var loading = h('div', { class: 'panel' },
      h('div', { class: 'loading-block', role: 'status', 'aria-live': 'polite' },
        h('span', { class: 'sr-only', text: 'Loading your teams' }),
        h('div', { class: 'skeleton-row w-40' }),
        h('div', { class: 'skeleton-row' }),
        h('div', { class: 'skeleton-row w-80' }),
        h('div', { class: 'skeleton-row w-60' }),
      ),
    );
    viewEl.appendChild(loading);
  }

  async function renderDashboard() {
    var statusNote = h('span', { class: 'context-note', text: 'Loading teams…' });
    var create = dashboardCreateForm(async function (team) {
      if (team && team.id) navigate('/app/teams/' + team.id);
    });
    showContextBar(create.form, h('div', { class: 'context-spacer' }), statusNote);
    renderDashboardLoading();

    async function load() {
      try {
        var data = await api('/api/teams');
        renderDashboardBody(data.teams || [], create.input);
      } catch (error) {
        statusNote.textContent = 'Could not load teams';
        clear(viewEl);
        viewEl.appendChild(h('div', { class: 'view-header' }, h('h1', { text: 'Dashboard' })));
        viewEl.appendChild(
          h('div', { class: 'error-state', role: 'alert' },
            h('p', { text: error.message || 'Could not load your teams.' }),
            h('button', { class: 'btn btn-secondary btn-sm', type: 'button', text: 'Retry', onclick: function () { renderDashboard(); } }),
          ),
        );
      }
    }

    function renderDashboardBody(teams, focusTarget) {
      clear(viewEl);
      var totalMembers = teams.reduce(function (sum, team) { return sum + team.memberCount; }, 0);
      var totalShares = teams.reduce(function (sum, team) { return sum + team.shareLinkCount; }, 0);
      var best = teams.reduce(function (acc, team) {
        var max = (team.weekHours || []).reduce(function (m, value) { return Math.max(m, value); }, 0);
        if (!acc || max > acc.hours) return { hours: max, team: team };
        return acc;
      }, null);

      statusNote.textContent = teams.length
        ? teams.length + (teams.length === 1 ? ' team' : ' teams') + ' \u00b7 ' + totalMembers + ' members'
        : 'No teams yet';

      var header = h('div', { class: 'view-header' },
        h('h1', { text: 'Dashboard' }),
        h('span', { class: 'meta', text: state.user ? 'Signed in as ' + state.user.email : '' }),
      );
      viewEl.appendChild(header);

      var stats = h('div', { class: 'stats' },
        h('div', { class: 'stat' },
          h('div', { class: 'stat-label', text: 'Teams' }),
          h('div', { class: 'stat-value', text: String(teams.length) }),
          h('div', { class: 'stat-meta', text: 'each with its own reference zone' }),
        ),
        h('div', { class: 'stat' },
          h('div', { class: 'stat-label', text: 'Members' }),
          h('div', { class: 'stat-value', text: String(totalMembers) }),
          h('div', { class: 'stat-meta', text: 'across all teams' }),
        ),
        h('div', { class: 'stat' },
          h('div', { class: 'stat-label', text: 'Best shared window' }),
          h('div', { class: 'stat-value', text: best ? formatHours(best.hours) : '—' }),
          h('div', { class: 'stat-meta', text: best && best.hours > 0 ? best.team.name : 'add members to see overlap' }),
        ),
        h('div', { class: 'stat' },
          h('div', { class: 'stat-label', text: 'Share links' }),
          h('div', { class: 'stat-value', text: String(totalShares) }),
          h('div', { class: 'stat-meta', text: 'read-only plans, no account needed' }),
        ),
      );
      viewEl.appendChild(stats);

      var panel = h('div', { class: 'panel' },
        h('div', { class: 'panel-head' },
          h('h2', { text: 'Your teams' }),
          h('span', { class: 'panel-sub', text: 'Shared window = hours per weekday when every member is inside working hours' }),
        ),
      );

      if (!teams.length) {
        panel.appendChild(
          h('div', { class: 'empty-state' },
            h('p', { class: 'empty-title', text: 'No teams yet' }),
            h('p', { class: 'empty-body', text: 'Create your first team with the “New team” control in the bar above, then add the people you plan meetings with.' }),
            h('button', {
              class: 'btn btn-primary',
              type: 'button',
              text: 'Create a team',
              onclick: function () { if (focusTarget) focusTarget.focus(); },
            }),
          ),
        );
      } else {
        var table = h('table', { class: 'data-table' });
        table.appendChild(
          h('thead', null,
            h('tr', null,
              h('th', { scope: 'col', text: 'Team' }),
              h('th', { scope: 'col', class: 'num', text: 'Members' }),
              h('th', { scope: 'col', text: 'Shared window, Mon–Sun' }),
              h('th', { scope: 'col', class: 'num', text: 'Share links' }),
              h('th', { scope: 'col', text: 'Updated' }),
              h('th', { scope: 'col', class: 'cell-actions', text: 'Actions' }),
            ),
          ),
        );
        var tbody = h('tbody');
        teams.forEach(function (team) {
          var average = weekdayAverage(team.weekHours);
          var lastUpdated = relativeTime(team.updatedAt);
          var row = h('tr', null,
            h('td', { 'data-label': 'Team' },
              h('div', { class: 'cell-stack' },
                h('a', { class: 'row-link', href: '/app/teams/' + team.id, text: team.name }),
                h('span', { class: 'secondary-text', text: 'Reference zone: ' + team.referenceZone }),
              ),
            ),
            h('td', { 'data-label': 'Members', class: 'num', text: String(team.memberCount) }),
            h('td', { 'data-label': 'Shared window' },
              h('div', { class: 'team-name-cell' },
                buildSpark(team.weekHours),
                h('span', { class: 'meta num', text: average ? formatHours(average) + '/day avg' : 'no overlap' }),
              ),
            ),
            h('td', { 'data-label': 'Share links', class: 'num', text: String(team.shareLinkCount) }),
            h('td', { 'data-label': 'Updated', class: 'meta', text: lastUpdated }),
            h('td', { 'data-label': 'Actions', class: 'cell-actions' },
              h('div', { class: 'team-actions' },
                h('a', { class: 'btn btn-secondary btn-sm', href: '/app/teams/' + team.id, text: 'Open planner' }),
              ),
            ),
          );
          tbody.appendChild(row);
        });
        table.appendChild(tbody);
        panel.appendChild(h('div', { class: 'table-wrap' }, table));
      }

      viewEl.appendChild(panel);
    }

    await load();
  }

  function formatHours(value) {
    if (!value) return '0 h';
    var rounded = Math.round(value * 10) / 10;
    return (Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)) + ' h';
  }

  /* ------------------------------------------------------------------ */
  /* Team planner                                                       */
  /* ------------------------------------------------------------------ */

  function plannerLoadingState() {
    clear(viewEl);
    viewEl.appendChild(h('div', { class: 'view-header' }, h('h1', { text: 'Team planner' })));
    viewEl.appendChild(
      h('div', { class: 'panel' },
        h('div', { class: 'loading-block', role: 'status', 'aria-live': 'polite' },
        h('span', { class: 'sr-only', text: 'Loading the team' }),
        h('div', { class: 'skeleton-row w-40' }),
        h('div', { class: 'skeleton-row' }),
        h('div', { class: 'skeleton-row w-80' }),
        ),
      ),
    );
  }

  async function renderPlanner(teamId) {
    plannerLoadingState();
    var results;
    try {
      results = await Promise.all([api('/api/teams/' + encodeURIComponent(teamId)), loadTimeZones()]);
    } catch (error) {
      if (error.status === 404) {
        clear(viewEl);
        viewEl.appendChild(
          h('div', { class: 'not-found' },
            h('h1', { text: 'Team not found' }),
            h('p', { text: 'It may have been deleted, or it belongs to another account.' }),
            h('a', { class: 'btn btn-primary', href: '/app', text: 'Back to dashboard' }),
          ),
        );
        return;
      }
      renderRouteError(error, function () { renderPlanner(teamId); });
      return;
    }

    var team = results[0].team;
    var zones = results[1];
    var members = team.members || [];
    var referenceZone = members.length ? members[0].timeZone : 'UTC';
    state.planner = {
      teamId: teamId,
      team: team,
      members: members,
      shareLinks: team.shareLinks || [],
      referenceZone: referenceZone,
      weekStart: TZ_UTILS.mondayOf(TZ_UTILS.dateKey(referenceZone, Date.now())),
      slotDate: team.defaultDate || TZ_UTILS.dateKey(referenceZone, Date.now()),
      slotDuration: 60,
      suggestions: null,
      zones: zones,
      editingMemberId: null,
      ui: {},
      busy: {},
    };

    mountPlanner();
    fetchSuggestions();
  }

  function mountPlanner() {
    var plan = state.planner;
    var ui = plan.ui;
    clear(viewEl);

    /* Context bar: reference zone switcher + week navigation */
    var zoneInput = h('input', {
      id: 'reference-zone',
      name: 'referenceZone',
      type: 'text',
      value: plan.referenceZone,
      list: 'reference-zone-list',
      autocomplete: 'off',
      spellcheck: 'false',
      class: 'reference-zone',
      'aria-describedby': 'reference-zone-hint',
    });
    var zoneList = h('datalist', { id: 'reference-zone-list' });
    fillDatalist(zoneList, plan.zones);
    var zoneApply = h('button', { class: 'btn btn-secondary btn-sm', type: 'submit', text: 'Apply' });
    var zoneError = h('span', { class: 'field-error', role: 'alert' });
    var zoneForm = h('form', { class: 'context-group', id: 'reference-zone-form' },
      h('label', { for: 'reference-zone', text: 'Reference zone' }),
      zoneInput, zoneApply, zoneList, zoneError,
    );
    zoneForm.addEventListener('submit', function (event) {
      event.preventDefault();
      var candidate = zoneInput.value.trim();
      if (plan.zones.indexOf(candidate) === -1) {
        zoneError.textContent = 'Pick a zone from the list.';
        zoneInput.setAttribute('aria-invalid', 'true');
        zoneInput.focus();
        return;
      }
      zoneError.textContent = '';
      zoneInput.removeAttribute('aria-invalid');
      plan.referenceZone = candidate;
      renderGrid();
      fetchSuggestions();
    });

    var weekLabel = h('span', { class: 'week-label', id: 'week-label' });
    var prevWeek = h('button', { class: 'btn btn-quiet btn-sm', type: 'button', text: '‹', 'aria-label': 'Previous week' });
    var nextWeek = h('button', { class: 'btn btn-quiet btn-sm', type: 'button', text: '›', 'aria-label': 'Next week' });
    var thisWeek = h('button', { class: 'btn btn-quiet btn-sm', type: 'button', text: 'This week' });
    prevWeek.addEventListener('click', function () { plan.weekStart = TZ_UTILS.addDays(plan.weekStart, -7); renderGrid(); });
    nextWeek.addEventListener('click', function () { plan.weekStart = TZ_UTILS.addDays(plan.weekStart, 7); renderGrid(); });
    thisWeek.addEventListener('click', function () {
      plan.weekStart = TZ_UTILS.mondayOf(TZ_UTILS.dateKey(plan.referenceZone, Date.now()));
      renderGrid();
    });
    var weekNav = h('div', { class: 'context-group' },
      h('span', { class: 'context-label', text: 'Week' }),
      h('div', { class: 'week-nav' }, prevWeek, weekLabel, nextWeek, thisWeek),
    );

    var sharedNote = h('span', { class: 'context-note', id: 'shared-note', role: 'status', 'aria-live': 'polite' });
    showContextBar(zoneForm, weekNav, h('div', { class: 'context-spacer' }), sharedNote);
    ui.sharedNote = sharedNote;
    ui.weekLabel = weekLabel;

    /* Header: title, member count, rename + delete */
    var renameInput = h('input', {
      id: 'rename-input', name: 'name', type: 'text', maxlength: '80',
      value: plan.team.name, 'aria-label': 'Team name',
    });
    var renameButton = h('button', { class: 'btn btn-secondary btn-sm', type: 'submit', text: 'Rename' });
    var renameStatus = h('span', { class: 'field-error', role: 'alert' });
    var renameForm = h('form', { class: 'rename-form', id: 'rename-form' }, renameInput, renameButton, renameStatus);
    renameForm.addEventListener('submit', async function (event) {
      event.preventDefault();
      if (renameForm.dataset.busy === 'true') return;
      var name = renameInput.value.trim();
      if (!name) {
        renameStatus.textContent = 'Give the team a name.';
        renameInput.focus();
        return;
      }
      renameForm.dataset.busy = 'true';
      busy(renameButton, true, 'Saving…');
      renameStatus.textContent = '';
      try {
        var data = await api('/api/teams/' + plan.teamId, { method: 'PATCH', body: { name: name } });
        plan.team = data.team;
        plan.members = data.team.members;
        plan.shareLinks = data.team.shareLinks;
        ui.title.textContent = data.team.name;
        document.title = data.team.name + ' · Zonebuddy';
      } catch (error) {
        renameStatus.textContent = (error.payload && error.payload.errors && error.payload.errors.name) || error.message;
      } finally {
        renameForm.dataset.busy = 'false';
        busy(renameButton, false);
      }
    });

    var deleteButton = h('button', { class: 'btn btn-danger-quiet btn-sm', type: 'button', text: 'Delete team' });
    var deleteWrap = h('div', { class: 'btn-group' }, deleteButton);
    deleteButton.addEventListener('click', function () {
      clear(deleteWrap);
      var confirmText = h('span', { class: 'confirm-inline', text: 'Delete this team, its members and its share links?' });
      var doDelete = h('button', { class: 'btn btn-danger btn-sm', type: 'button', text: 'Delete' });
      var cancel = h('button', { class: 'btn btn-quiet btn-sm', type: 'button', text: 'Cancel' });
      deleteWrap.append(confirmText, doDelete, cancel);
      cancel.focus();
      cancel.addEventListener('click', function () {
        clear(deleteWrap);
        deleteWrap.appendChild(deleteButton);
      });
      doDelete.addEventListener('click', async function () {
        doDelete.disabled = true;
        try {
          await api('/api/teams/' + plan.teamId, { method: 'DELETE' });
          navigate('/app');
        } catch (error) {
          confirmText.textContent = error.message;
          doDelete.disabled = false;
        }
      });
    });

    ui.title = h('h1', { text: plan.team.name });
    ui.memberBadge = h('span', { class: 'badge badge-accent' });
    ui.updated = h('span', { class: 'meta' });

    viewEl.appendChild(
      h('div', { class: 'view-header' },
        ui.title,
        ui.memberBadge,
        ui.updated,
        h('div', { class: 'planner-header-actions' }, renameForm, deleteWrap),
      ),
    );
    viewEl.appendChild(
      h('p', { class: 'view-lede', text: 'Members keep their own working hours and home zone. The grid shades every hour in the reference zone you pick, and the slot list ranks the times that fit everyone.' }),
    );

    var layout = h('div', { class: 'planner-layout' });
    layout.appendChild(buildMembersPanel());
    layout.appendChild(buildGridPanel());
    layout.appendChild(buildSlotsPanel());
    layout.appendChild(buildSharePanel());
    viewEl.appendChild(layout);

    renderMembersTable();
    renderGrid();
    renderShareList();
  }

  /* ------------------------------ Members --------------------------- */

  function buildMembersPanel() {
    var plan = state.planner;
    var ui = plan.ui;

    ui.memberCount = h('span', { class: 'panel-sub' });
    ui.membersBody = h('div', { class: 'panel-body tight' });

    var nameInput = h('input', {
      id: 'member-name', name: 'name', type: 'text', maxlength: '60',
      placeholder: 'e.g. Amara Osei', autocomplete: 'off', required: true,
    });
    var zoneInput = h('input', {
      id: 'member-zone', name: 'timeZone', type: 'text', list: 'zone-list',
      value: plan.referenceZone, autocomplete: 'off', spellcheck: 'false', required: true,
      'aria-describedby': 'member-zone-hint',
    });
    var zoneList = h('datalist', { id: 'zone-list' });
    fillDatalist(zoneList, plan.zones);
    var startInput = h('input', { id: 'member-start', name: 'workStart', type: 'time', value: '09:00', required: true });
    var endInput = h('input', { id: 'member-end', name: 'workEnd', type: 'time', value: '17:00', required: true });

    var colorOptions = [
      { color: '#528a54', label: 'Sage' },
      { color: '#0072B2', label: 'Ocean' },
      { color: '#D55E00', label: 'Ember' },
      { color: '#009E73', label: 'Fern' },
      { color: '#CC79A7', label: 'Orchid' },
      { color: '#E69F00', label: 'Amber' },
    ];
    var colorPicker = h('div', { class: 'color-picker', role: 'radiogroup', 'aria-label': 'Member colour' });
    colorOptions.forEach(function (option, index) {
      var input = h('input', {
        type: 'radio', name: 'color', value: option.color, id: 'color-' + index,
        checked: index === 0 ? true : null,
      });
      colorPicker.appendChild(
        h('label', { class: 'color-option', for: 'color-' + index },
          input,
          h('span', { class: 'swatch ' + swatchClass(option.color) }),
          h('span', { text: option.label }),
        ),
      );
    });

    var formTitle = h('h3', { class: 'form-legend', id: 'member-form-title', text: 'Add member' });
    var errorsBox = h('div', { class: 'form-errors', role: 'alert', 'aria-live': 'polite' });
    var nameError = h('p', { class: 'field-error', id: 'member-name-error', role: 'alert' });
    var zoneError = h('p', { class: 'field-error', id: 'member-zone-error', role: 'alert' });
    var startError = h('p', { class: 'field-error', id: 'member-start-error', role: 'alert' });
    var endError = h('p', { class: 'field-error', id: 'member-end-error', role: 'alert' });

    var submitButton = h('button', { class: 'btn btn-primary', type: 'submit', text: 'Add member' });
    var cancelButton = h('button', { class: 'btn btn-quiet', type: 'button', text: 'Cancel edit', hidden: true });
    var status = h('p', { class: 'status-line', role: 'status', 'aria-live': 'polite' });

    var form = h('form', { class: 'planner-form', id: 'member-form', novalidate: true },
      formTitle,
      h('div', { class: 'field' },
        h('label', { for: 'member-name', text: 'Name' }),
        nameInput,
        nameError,
      ),
      h('div', { class: 'field' },
        h('label', { for: 'member-zone', text: 'Home time zone' }),
        zoneInput,
        zoneList,
        h('p', { class: 'hint', id: 'member-zone-hint', text: 'Any IANA zone — start typing to search, e.g. Europe/Berlin.' }),
        zoneError,
      ),
      h('div', { class: 'field-row' },
        h('div', { class: 'field' }, h('label', { for: 'member-start', text: 'Works from' }), startInput, startError),
        h('div', { class: 'field' }, h('label', { for: 'member-end', text: 'Works until' }), endInput, endError),
      ),
      h('div', { class: 'field' }, h('span', { class: 'form-legend', text: 'Colour' }), colorPicker),
      errorsBox,
      h('div', { class: 'member-form-actions' }, submitButton, cancelButton),
      status,
    );

    function resetForm() {
      plan.editingMemberId = null;
      formTitle.textContent = 'Add member';
      submitButton.textContent = 'Add member';
      cancelButton.hidden = true;
      nameInput.value = '';
      zoneInput.value = plan.referenceZone;
      startInput.value = '09:00';
      endInput.value = '17:00';
      colorPicker.querySelectorAll('input[name="color"]').forEach(function (input, index) {
        input.checked = index === ((plan.members.length) % 6);
      });
      [nameInput, zoneInput, startInput, endInput].forEach(function (input) { input.removeAttribute('aria-invalid'); });
      [nameError, zoneError, startError, endError, errorsBox].forEach(function (node) { node.textContent = ''; });
    }

    cancelButton.addEventListener('click', function () {
      resetForm();
      status.textContent = '';
      status.className = 'status-line';
      nameInput.focus();
    });

    ui.startEditingMember = function (member) {
      plan.editingMemberId = member.id;
      formTitle.textContent = 'Edit member';
      submitButton.textContent = 'Save changes';
      cancelButton.hidden = false;
      nameInput.value = member.name;
      zoneInput.value = member.timeZone;
      startInput.value = member.workStart;
      endInput.value = member.workEnd;
      var colorInput = colorPicker.querySelector('input[value="' + member.color + '"]');
      if (colorInput) colorInput.checked = true;
      [nameError, zoneError, startError, endError, errorsBox].forEach(function (node) { node.textContent = ''; });
      nameInput.focus();
      form.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    };

    ui.memberForm = { nameInput: nameInput, zoneInput: zoneInput, resetForm: resetForm, status: status };

    form.addEventListener('submit', async function (event) {
      event.preventDefault();
      if (form.dataset.busy === 'true') return;

      var name = nameInput.value.trim();
      var zone = zoneInput.value.trim();
      var start = startInput.value;
      var end = endInput.value;
      var colorInput = colorPicker.querySelector('input[name="color"]:checked');
      var clientErrors = {};
      if (!name) clientErrors.name = 'Enter the member’s name.';
      if (!zone) clientErrors.timeZone = 'Choose a time zone.';
      else if (plan.zones.indexOf(zone) === -1) clientErrors.timeZone = 'Pick a time zone from the list, e.g. Europe/Berlin.';
      if (!start) clientErrors.workStart = 'Enter a start time.';
      if (!end) clientErrors.workEnd = 'Enter an end time.';
      if (!clientErrors.workStart && !clientErrors.workEnd && start && end && end <= start) {
        clientErrors.workEnd = 'The end time must be after the start time.';
      }
      errorsBox.textContent = '';
      [nameError, zoneError, startError, endError].forEach(function (node) { node.textContent = ''; });
      [nameInput, zoneInput, startInput, endInput].forEach(function (input) { input.removeAttribute('aria-invalid'); });
      Object.keys(clientErrors).forEach(function (key) {
        var map = { name: nameError, timeZone: zoneError, workStart: startError, workEnd: endError };
        if (map[key]) map[key].textContent = clientErrors[key];
        var inputMap = { name: nameInput, timeZone: zoneInput, workStart: startInput, workEnd: endInput };
        if (inputMap[key]) inputMap[key].setAttribute('aria-invalid', 'true');
      });
      if (Object.keys(clientErrors).length) {
        if (clientErrors.name) nameInput.focus();
        else if (clientErrors.timeZone) zoneInput.focus();
        else if (clientErrors.workStart) startInput.focus();
        else endInput.focus();
        return;
      }

      var payload = { name: name, timeZone: zone, workStart: start, workEnd: end, color: colorInput ? colorInput.value : '#528a54' };
      var editingId = plan.editingMemberId;
      form.dataset.busy = 'true';
      busy(submitButton, true, editingId ? 'Saving…' : 'Adding…');
      try {
        if (editingId) {
          await api('/api/teams/' + plan.teamId + '/members/' + editingId, { method: 'PATCH', body: payload });
        } else {
          await api('/api/teams/' + plan.teamId + '/members', { method: 'POST', body: payload });
        }
        resetForm();
        await refreshTeam();
        status.textContent = editingId ? 'Member updated.' : 'Member added.';
        status.className = 'status-line is-ok';
      } catch (error) {
        var serverErrors = (error.payload && error.payload.errors) || {};
        if (Object.keys(serverErrors).length) {
          var targets = { name: nameError, timeZone: zoneError, workStart: startError, workEnd: endError };
          Object.keys(serverErrors).forEach(function (key) {
            if (targets[key]) targets[key].textContent = serverErrors[key];
          });
          errorsBox.textContent = error.payload.error || '';
        } else {
          status.textContent = error.message;
          status.className = 'status-line is-error';
        }
      } finally {
        form.dataset.busy = 'false';
        busy(submitButton, false);
      }
    });

    return h('section', { class: 'panel panel-members', 'aria-labelledby': 'members-heading' },
      h('div', { class: 'panel-head' },
        h('h2', { id: 'members-heading', text: 'Members' }),
        ui.memberCount,
      ),
      ui.membersBody,
      h('div', { class: 'panel-body' }, form),
    );
  }

  function renderMembersTable() {
    var plan = state.planner;
    var ui = plan.ui;
    clearTimers();
    clear(ui.membersBody);
    ui.memberCount.textContent = plan.members.length + (plan.members.length === 1 ? ' person' : ' people');
    ui.memberBadge.textContent = plan.members.length + (plan.members.length === 1 ? ' member' : ' members');
    ui.updated.textContent = 'Updated ' + relativeTime(plan.team.updatedAt);

    if (!plan.members.length) {
      ui.membersBody.appendChild(
        h('div', { class: 'empty-state' },
          h('p', { class: 'empty-title', text: 'No members yet' }),
          h('p', { class: 'empty-body', text: 'Add the people you plan meetings with — their home zone and working hours drive the whole grid.' }),
          h('button', {
            class: 'btn btn-primary btn-sm', type: 'button', text: 'Add the first member',
            onclick: function () { if (ui.memberForm) ui.memberForm.nameInput.focus(); },
          }),
        ),
      );
      return;
    }

    var table = h('table', { class: 'data-table' });
    table.appendChild(
      h('thead', null,
        h('tr', null,
          h('th', { scope: 'col', text: 'Member' }),
          h('th', { scope: 'col', text: 'Working hours' }),
          h('th', { scope: 'col', text: 'Local now' }),
          h('th', { scope: 'col', class: 'cell-actions', text: '' }),
        ),
      ),
    );
    var tbody = h('tbody');
    plan.members.forEach(function (member) {
      var nowCell = h('span', { class: 'local-now', text: TZ_UTILS.timeLabel(member.timeZone, Date.now()) });
      var actions = h('div', { class: 'btn-group' });
      var editButton = h('button', { class: 'btn btn-quiet btn-sm', type: 'button', text: 'Edit', 'aria-label': 'Edit ' + member.name });
      editButton.addEventListener('click', function () { ui.startEditingMember(member); });
      var deleteButton = h('button', { class: 'btn btn-danger-quiet btn-sm', type: 'button', text: 'Remove', 'aria-label': 'Remove ' + member.name });
      deleteButton.addEventListener('click', function () {
        clear(actions);
        var confirm = h('span', { class: 'confirm-inline', text: 'Remove?' });
        var yes = h('button', { class: 'btn btn-danger btn-sm', type: 'button', text: 'Remove' });
        var no = h('button', { class: 'btn btn-quiet btn-sm', type: 'button', text: 'Cancel' });
        actions.append(confirm, yes, no);
        no.focus();
        no.addEventListener('click', function () {
          clear(actions);
          actions.append(editButton, deleteButton);
        });
        yes.addEventListener('click', async function () {
          yes.disabled = true;
          try {
            await api('/api/teams/' + plan.teamId + '/members/' + member.id, { method: 'DELETE' });
            await refreshTeam();
            var status = ui.memberForm && ui.memberForm.status;
            if (status) {
              status.textContent = 'Member removed.';
              status.className = 'status-line is-ok';
            }
          } catch (error) {
            confirm.textContent = error.message;
            yes.disabled = false;
          }
        });
      });
      actions.append(editButton, deleteButton);

      tbody.appendChild(
        h('tr', null,
          h('td', { 'data-label': 'Member' },
            h('div', { class: 'member-name-cell' },
              h('span', { class: 'swatch ' + swatchClass(member.color), title: 'Member colour' }),
              h('div', { class: 'cell-stack' },
                h('span', { class: 'primary-text', text: member.name }),
                h('span', { class: 'secondary-text', text: member.timeZone }),
              ),
            ),
          ),
          h('td', { 'data-label': 'Working hours' },
            h('div', { class: 'cell-stack' },
              h('span', { class: 'num', text: member.workStart + '–' + member.workEnd }),
              h('span', { class: 'secondary-text', text: TZ_UTILS.zoneAbbr(member.timeZone) }),
            ),
          ),
          h('td', { 'data-label': 'Local now', class: 'num' }, nowCell),
          h('td', { 'data-label': 'Actions', class: 'cell-actions' }, actions),
        ),
      );
    });
    table.appendChild(tbody);
    ui.membersBody.appendChild(h('div', { class: 'table-wrap' }, table));

    var clock = window.setInterval(function () {
      if (!state.planner) return;
      tbody.querySelectorAll('.local-now').forEach(function (node, index) {
        var member = state.planner.members[index];
        if (member) node.textContent = TZ_UTILS.timeLabel(member.timeZone, Date.now());
      });
    }, 60000);
    addTimer(clock);
  }

  async function refreshTeam() {
    var plan = state.planner;
    var data = await api('/api/teams/' + plan.teamId);
    plan.team = data.team;
    plan.members = data.team.members;
    plan.shareLinks = data.team.shareLinks;
    renderMembersTable();
    renderGrid();
    renderShareList();
    fetchSuggestions();
  }

  /* ------------------------------------------------------------------ */
  /* Overlap grid (shared by the planner and the public plan)            */
  /* ------------------------------------------------------------------ */

  function intersectIntervalSets(a, b) {
    var out = [];
    a.forEach(function (left) {
      b.forEach(function (right) {
        var start = Math.max(left[0], right[0]);
        var end = Math.min(left[1], right[1]);
        if (end > start) out.push([start, end]);
      });
    });
    return out;
  }

  function sharedHoursForDay(members, dateStr, referenceZone) {
    if (!members.length) return 0;
    var dayStart = TZ_UTILS.zonedToUtc(dateStr, 0, referenceZone);
    var dayEnd = TZ_UTILS.zonedToUtc(TZ_UTILS.addDays(dateStr, 1), 0, referenceZone);
    var shared = [[dayStart, dayEnd]];
    for (var index = 0; index < members.length; index += 1) {
      shared = intersectIntervalSets(shared, TZ_UTILS.workingIntervals(members[index], dayStart, dayEnd));
      if (!shared.length) return 0;
    }
    var total = shared.reduce(function (sum, interval) { return sum + (interval[1] - interval[0]); }, 0);
    return Math.round((total / 3600000) * 10) / 10;
  }

  function buildLegendItem(member, referenceZone) {
    return h('span', { class: 'legend-item' },
      h('span', { class: 'swatch ' + swatchClass(member.color) }),
      h('strong', { text: member.name }),
      h('span', { class: 'legend-zone', text: member.workStart + '–' + member.workEnd + ' ' + member.timeZone }),
    );
  }

  function renderGridInto(ui, members, referenceZone, weekStart) {
    var zone = referenceZone;
    var mondayInstant = TZ_UTILS.zonedToUtc(weekStart, 0, zone);
    var sundayInstant = TZ_UTILS.zonedToUtc(TZ_UTILS.addDays(weekStart, 6), 0, zone);
    if (ui.weekLabel) ui.weekLabel.textContent = TZ_UTILS.dateLabel(zone, mondayInstant) + ' – ' + TZ_UTILS.dateLabel(zone, sundayInstant);
    if (ui.gridZoneNote) ui.gridZoneNote.textContent = 'Hours in ' + zone + ' (' + TZ_UTILS.zoneAbbr(zone) + ')';

    if (ui.gridLegend) {
      clear(ui.gridLegend);
      members.forEach(function (member) {
        ui.gridLegend.appendChild(buildLegendItem(member, zone));
      });
    }

    var todayKey = TZ_UTILS.dateKey(zone, Date.now());
    var weekdays = [];
    for (var dayIndex = 0; dayIndex < 5; dayIndex += 1) {
      weekdays.push(sharedHoursForDay(members, TZ_UTILS.addDays(weekStart, dayIndex), zone));
    }
    var todayHours = sharedHoursForDay(members, TZ_UTILS.dateKey(zone, Date.now()), zone);
    var average = Math.round((weekdays.reduce(function (sum, value) { return sum + value; }, 0) / 5) * 10) / 10;

    if (ui.sharedNote) {
      ui.sharedNote.textContent = members.length
        ? formatHours(todayHours) + ' shared today \u00b7 ' + formatHours(average) + '/day Mon\u2013Fri'
        : 'No members yet';
    }

    if (!ui.gridContainer) return { average: average, todayHours: todayHours };

    clear(ui.gridContainer);
    if (!members.length) {
      ui.gridContainer.appendChild(
        h('div', { class: 'empty-state' },
          h('p', { class: 'empty-title', text: 'The grid fills in once you add members' }),
          h('p', { class: 'empty-body', text: 'Each member brings a home time zone and working hours. Zonebuddy shades the hours they are at work in the reference zone above.' }),
        ),
      );
      return { average: average, todayHours: todayHours };
    }

    var grid = h('div', { class: 'overlap-grid', 'aria-hidden': 'true' });
    grid.appendChild(h('div', { class: 'grid-corner', text: 'Day \\ Hour' }));
    for (var hour = 0; hour < 24; hour += 1) {
      grid.appendChild(h('div', { class: 'grid-hour num', text: (hour < 10 ? '0' : '') + hour }));
    }

    var summaryLines = [];
    for (var day = 0; day < 7; day += 1) {
      var date = TZ_UTILS.addDays(weekStart, day);
      var dayStart = TZ_UTILS.zonedToUtc(date, 0, zone);
      var dayEnd = TZ_UTILS.zonedToUtc(TZ_UTILS.addDays(date, 1), 0, zone);
      var perMember = members.map(function (member) {
        return TZ_UTILS.workingIntervals(member, dayStart, dayEnd);
      });
      var isToday = date === todayKey;

      var dayLabelInstant = TZ_UTILS.zonedToUtc(date, 720, zone);
      grid.appendChild(
        h('div', { class: 'grid-day' + (isToday ? ' is-today' : '') },
          h('span', { text: TZ_UTILS.shortDay(zone, dayLabelInstant) + (isToday ? ' · today' : '') }),
          h('span', { class: 'grid-day-date', text: TZ_UTILS.dateLabel(zone, dayLabelInstant) }),
        ),
      );

      var dayHourLabels = [];
      for (var hourIndex = 0; hourIndex < 24; hourIndex += 1) {
        var instant = TZ_UTILS.zonedToUtc(date, hourIndex * 60, zone);
        var working = [];
        members.forEach(function (member, memberIndex) {
          var inside = perMember[memberIndex].some(function (interval) {
            return instant >= interval[0] && instant < interval[1];
          });
          if (inside) working.push(member);
        });
        var level = working.length === 0 ? 0 : Math.min(6, working.length);
        var label = TZ_UTILS.dayLabel(zone, instant) + ' ' + (hourIndex < 10 ? '0' : '') + hourIndex + ':00 ' + zone;
        var description = label + ' — ';
        if (!working.length) {
          description += 'nobody working';
        } else if (working.length === members.length) {
          description += 'everyone working (' + working.map(function (m) { return m.name; }).join(', ') + ')';
        } else {
          description += working.length + ' of ' + members.length + ' working (' + working.map(function (m) { return m.name; }).join(', ') + ')';
        }

        var cell = h('div', {
          class: 'grid-cell' + (isToday ? ' is-today' : ''),
          dataset: level ? { level: String(level) } : {},
          title: description,
        });
        if (working.length) {
          var dots = h('span', { class: 'cell-dots' });
          working.slice(0, 4).forEach(function (member) {
            dots.appendChild(h('span', { class: 'dot ' + seriesClass(member.color) }));
          });
          cell.appendChild(dots);
        }
        grid.appendChild(cell);
        if (working.length) dayHourLabels.push((hourIndex < 10 ? '0' : '') + hourIndex);
      }

      summaryLines.push(
        TZ_UTILS.dayLabel(zone, dayLabelInstant) +
          (dayHourLabels.length
            ? ': ' + dayHourLabels.length + ' shared hour(s) starting ' + dayHourLabels[0] + ':00'
            : ': no shared hours'),
      );
    }

    ui.gridContainer.appendChild(grid);
    ui.gridContainer.appendChild(h('p', { class: 'sr-only', text: 'Working-hours overlap for ' + zone + '. ' + summaryLines.join('. ') }));
    return { average: average, todayHours: todayHours };
  }

  /* ------------------------------------------------------------------ */
  /* Planner: grid, slots, share                                        */
  /* ------------------------------------------------------------------ */

  function buildGridPanel() {
    var ui = state.planner.ui;
    ui.gridZoneNote = h('span', { class: 'panel-sub' });
    ui.gridLegend = h('div', { class: 'legend' });
    ui.gridContainer = h('div', { class: 'grid-scroll' });
    return h('section', { class: 'panel panel-grid', 'aria-labelledby': 'grid-heading' },
      h('div', { class: 'panel-head' },
        h('h2', { id: 'grid-heading', text: 'Overlap this week' }),
        ui.gridZoneNote,
      ),
      ui.gridLegend,
      ui.gridContainer,
    );
  }

  function renderGrid() {
    var plan = state.planner;
    if (!plan || !plan.ui) return;
    renderGridInto(plan.ui, plan.members, plan.referenceZone, plan.weekStart);
  }

  function buildSlotsPanel() {
    var plan = state.planner;
    var ui = plan.ui;

    ui.slotDateInput = h('input', { id: 'slot-date', name: 'date', type: 'date', value: plan.slotDate, required: true });
    ui.slotDurationInput = h('select', { id: 'slot-duration', name: 'duration' },
      h('option', { value: '30', text: '30 min' }),
      h('option', { value: '60', text: '60 min', selected: true }),
      h('option', { value: '90', text: '90 min' }),
    );
    var slotError = h('span', { class: 'field-error', role: 'alert', id: 'slot-error' });
    var submit = h('button', { class: 'btn btn-primary btn-sm', type: 'submit', text: 'Find slots' });
    var form = h('form', { class: 'slot-controls', id: 'slot-form' },
      h('div', { class: 'field' }, h('label', { for: 'slot-date', text: 'Date' }), ui.slotDateInput),
      h('div', { class: 'field' }, h('label', { for: 'slot-duration', text: 'Length' }), ui.slotDurationInput),
      submit,
      slotError,
    );

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var date = ui.slotDateInput.value;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        slotError.textContent = 'Pick a date.';
        ui.slotDateInput.focus();
        return;
      }
      slotError.textContent = '';
      plan.slotDate = date;
      plan.slotDuration = Number(ui.slotDurationInput.value) || 60;
      fetchSuggestions();
    });

    ui.slotResults = h('div', { id: 'slot-results', 'aria-live': 'polite' });
    ui.slotSubmit = submit;

    return h('section', { class: 'panel panel-slots', 'aria-labelledby': 'slots-heading' },
      h('div', { class: 'panel-head' },
        h('h2', { id: 'slots-heading', text: 'Meeting slots' }),
        h('span', { class: 'panel-sub', text: 'Ranked by how centred each slot sits in everyone\u2019s day' }),
      ),
      form,
      ui.slotResults,
    );
  }

  function slotsLoading() {
    var ui = state.planner.ui;
    clear(ui.slotResults);
    ui.slotResults.appendChild(
      h('div', { class: 'loading-block', role: 'status' },
        h('span', { class: 'sr-only', text: 'Finding meeting slots' }),
        h('div', { class: 'skeleton-row w-60' }),
        h('div', { class: 'skeleton-row w-80' }),
        h('div', { class: 'skeleton-row w-40' }),
      ),
    );
  }

  async function fetchSuggestions() {
    var plan = state.planner;
    if (!plan || !plan.ui || !plan.ui.slotResults) return;
    var requestId = (plan.suggestionRequest || 0) + 1;
    plan.suggestionRequest = requestId;
    slotsLoading();
    var query = new URLSearchParams({
      date: plan.slotDate,
      duration: String(plan.slotDuration),
      referenceZone: plan.referenceZone,
    });
    try {
      var data = await api('/api/teams/' + plan.teamId + '/suggestions?' + query.toString());
      if (plan.suggestionRequest !== requestId) return;
      plan.suggestions = data;
      renderSlotResults(data, plan.ui.slotResults, {
        zone: plan.referenceZone,
        onRetry: fetchSuggestions,
        onNextDate: function (nextDate) {
          plan.slotDate = nextDate;
          plan.ui.slotDateInput.value = nextDate;
          fetchSuggestions();
        },
      });
    } catch (error) {
      if (plan.suggestionRequest !== requestId) return;
      renderSlotError(plan.ui.slotResults, error.message, fetchSuggestions);
    }
  }

  function renderSlotError(container, message, onRetry) {
    clear(container);
    container.appendChild(
      h('div', { class: 'panel-body' },
        h('div', { class: 'error-state', role: 'alert' },
          h('p', { text: message || 'Could not compute meeting slots.' }),
          h('button', { class: 'btn btn-secondary btn-sm', type: 'button', text: 'Retry', onclick: onRetry }),
        ),
      ),
    );
  }

  function renderSlotResults(data, container, options) {
    var opts = options || {};
    clear(container);
    var zone = data.referenceZone || opts.zone || 'UTC';

    if (!data.slots || !data.slots.length) {
      var emptyBody = h('div', { class: 'empty-state' },
        h('p', { class: 'empty-title', text: 'No shared slot on this date' }),
        h('p', { class: 'empty-body', text: data.reason || 'Nobody on this team is inside working hours on the selected date.' }),
      );
      if (data.nextDate) {
        emptyBody.appendChild(
          h('button', {
            class: 'btn btn-secondary btn-sm',
            type: 'button',
            text: 'Try ' + (data.nextLabel || data.nextDate),
            onclick: function () { if (opts.onNextDate) opts.onNextDate(data.nextDate); },
          }),
        );
      }
      container.appendChild(emptyBody);
      return;
    }

    container.appendChild(
      h('p', { class: 'slot-note' },
        data.slots.length + (data.slots.length === 1 ? ' slot' : ' slots') + ' on ' +
          TZ_UTILS.dayLabel(zone, Date.parse(data.slots[0].startUtc)) + ' \u00b7 times in ' + zone,
      ),
    );

    var list = h('ol', { class: 'slot-list' });
    data.slots.forEach(function (slot) {
      var chips = h('div', { class: 'slot-members' });
      (slot.members || []).forEach(function (member) {
        chips.appendChild(
          h('span', { class: 'member-chip', title: member.timeZone },
            h('span', { class: 'dot ' + seriesClass(member.color) }),
            h('span', { text: member.name }),
            h('span', { class: 'member-chip-hours', text: member.localStart + '\u2013' + member.localEnd }),
          ),
        );
      });
      list.appendChild(
        h('li', { class: 'slot-row' + (slot.rank === 1 ? ' is-best' : '') },
          h('span', { class: 'slot-rank', text: String(slot.rank) }),
          h('div', { class: 'slot-main' },
            h('div', { class: 'slot-time' },
              h('strong', { text: slot.startLocal + '\u2013' + slot.endLocal }),
              h('span', { class: 'slot-zone', text: TZ_UTILS.dayLabel(zone, Date.parse(slot.startUtc)) + ' \u00b7 ' + zone + ' (' + TZ_UTILS.zoneAbbr(zone, Date.parse(slot.startUtc)) + ')' }),
            ),
            chips,
          ),
          h('div', { class: 'slot-side' },
            slot.rank === 1 ? h('span', { class: 'badge badge-accent', text: 'Best fit' }) : null,
            h('span', { class: 'meta', text: '\u00b1' + slot.comfortMinutes + ' min from midday' }),
          ),
        ),
      );
    });
    container.appendChild(list);
  }

  function buildSharePanel() {
    var plan = state.planner;
    var ui = plan.ui;

    ui.shareStatus = h('p', { class: 'status-line', role: 'status', 'aria-live': 'polite' });
    ui.shareList = h('ul', { class: 'share-list', id: 'share-list' });

    var createButton = h('button', { class: 'btn btn-secondary', type: 'button', id: 'create-share', text: 'Create share link' });
    createButton.addEventListener('click', async function () {
      if (createButton.dataset.busy === 'true') return;
      createButton.dataset.busy = 'true';
      busy(createButton, true, 'Creating…');
      try {
        var data = await api('/api/teams/' + plan.teamId + '/share-links', { method: 'POST' });
        plan.shareLinks = plan.shareLinks.concat([data.shareLink]);
        renderShareList();
        ui.shareStatus.textContent = 'Share link created — anyone with the URL can read this plan.';
        ui.shareStatus.className = 'status-line is-ok';
      } catch (error) {
        ui.shareStatus.textContent = error.message;
        ui.shareStatus.className = 'status-line is-error';
      } finally {
        createButton.dataset.busy = 'false';
        busy(createButton, false);
      }
    });

    return h('section', { class: 'panel panel-share', 'aria-labelledby': 'share-heading' },
      h('div', { class: 'panel-head' }, h('h2', { id: 'share-heading', text: 'Share a plan' })),
      h('div', { class: 'panel-body' },
        h('div', { class: 'share-form' },
          h('p', { class: 'meta', text: 'A share link shows the members, the overlap grid and the slot suggestions. Readers cannot edit anything.' }),
          createButton,
          ui.shareStatus,
          ui.shareList,
        ),
      ),
    );
  }

  function renderShareList() {
    var plan = state.planner;
    var ui = plan.ui;
    clear(ui.shareList);

    if (!plan.shareLinks.length) {
      ui.shareList.appendChild(
        h('li', { class: 'share-meta', text: 'No share links yet. Create one to paste into chat or a doc.' }),
      );
      return;
    }

    plan.shareLinks.forEach(function (link) {
      var url = window.location.origin + '/share/' + link.token;
      var input = h('input', { class: 'share-url', type: 'text', readonly: true, value: url, 'aria-label': 'Share link URL' });
      var copy = h('button', { class: 'btn btn-secondary btn-sm', type: 'button', text: 'Copy' });
      var open = h('a', { class: 'btn btn-quiet btn-sm', href: '/share/' + link.token, text: 'Open' });
      var revoke = h('button', { class: 'btn btn-danger-quiet btn-sm', type: 'button', text: 'Revoke' });
      var actions = h('div', { class: 'btn-group' }, copy, open, revoke);

      copy.addEventListener('click', async function () {
        var copied = false;
        try {
          await navigator.clipboard.writeText(url);
          copied = true;
        } catch (error) {
          copied = false;
        }
        if (!copied) {
          input.focus();
          input.select();
        }
        ui.shareStatus.textContent = copied
          ? 'Link copied to clipboard.'
          : 'Clipboard blocked by the browser — the URL is selected, press Ctrl+C (⌘C on a Mac).';
        ui.shareStatus.className = 'status-line ' + (copied ? 'is-ok' : 'is-error');
        window.setTimeout(function () {
          if (ui.shareStatus) {
            ui.shareStatus.textContent = '';
            ui.shareStatus.className = 'status-line';
          }
        }, 5000);
      });

      revoke.addEventListener('click', function () {
        clear(actions);
        var confirm = h('span', { class: 'confirm-inline', text: 'Revoke this link?' });
        var yes = h('button', { class: 'btn btn-danger btn-sm', type: 'button', text: 'Revoke' });
        var no = h('button', { class: 'btn btn-quiet btn-sm', type: 'button', text: 'Cancel' });
        actions.append(confirm, yes, no);
        no.focus();
        no.addEventListener('click', function () {
          clear(actions);
          actions.append(copy, open, revoke);
        });
        yes.addEventListener('click', async function () {
          yes.disabled = true;
          try {
            await api('/api/teams/' + plan.teamId + '/share-links/' + link.id, { method: 'DELETE' });
            plan.shareLinks = plan.shareLinks.filter(function (entry) { return entry.id !== link.id; });
            renderShareList();
            ui.shareStatus.textContent = 'Share link revoked.';
            ui.shareStatus.className = 'status-line is-ok';
          } catch (error) {
            confirm.textContent = error.message;
            yes.disabled = false;
          }
        });
      });

      ui.shareList.appendChild(
        h('li', { class: 'share-row' },
          input,
          actions,
          h('span', { class: 'share-meta', text: 'Created ' + relativeTime(link.createdAt) }),
        ),
      );
    });
  }

  /* ------------------------------------------------------------------ */
  /* Public read-only plan                                              */
  /* ------------------------------------------------------------------ */

  function renderShareNotFound() {
    clear(viewEl);
    viewEl.appendChild(
      h('div', { class: 'not-found' },
        h('h1', { text: 'This plan link is no longer available' }),
        h('p', { text: 'The team owner may have revoked the link, or the team itself was deleted.' }),
        h('div', { class: 'btn-group' },
          h('a', { class: 'btn btn-primary', href: '/login', text: 'Sign in to Zonebuddy' }),
          h('a', { class: 'btn btn-quiet', href: '/signup', text: 'Create a free account' }),
        ),
      ),
    );
  }

  async function renderShare(token) {
    clear(viewEl);
    viewEl.appendChild(h('div', { class: 'boot-state', role: 'status', text: 'Loading the shared plan…' }));

    var data;
    try {
      data = await api('/api/share/' + encodeURIComponent(token));
    } catch (error) {
      if (error.status === 404) {
        renderShareNotFound();
        return;
      }
      renderRouteError(error, function () { renderShare(token); });
      return;
    }

    var referenceZone = data.referenceZone || 'UTC';
    state.share = {
      token: token,
      data: data,
      members: data.members || [],
      referenceZone: referenceZone,
      weekStart: TZ_UTILS.mondayOf(TZ_UTILS.dateKey(referenceZone, Date.now())),
      slotDate: data.defaultDate || TZ_UTILS.dateKey(referenceZone, Date.now()),
      slotDuration: 60,
      zones: data.timeZones || browserTimeZones(),
      ui: {},
      request: 0,
    };
    mountShareView();
  }

  function mountShareView() {
    var share = state.share;
    var ui = share.ui;
    var plan = share;

    clear(viewEl);

    var zoneInput = h('input', {
      id: 'share-reference-zone', name: 'referenceZone', type: 'text', value: share.referenceZone,
      list: 'share-zone-list', autocomplete: 'off', spellcheck: 'false', class: 'reference-zone',
    });
    var zoneList = h('datalist', { id: 'share-zone-list' });
    fillDatalist(zoneList, share.zones);
    var zoneApply = h('button', { class: 'btn btn-secondary btn-sm', type: 'submit', text: 'Apply' });
    var zoneError = h('span', { class: 'field-error', role: 'alert' });
    var zoneForm = h('form', { class: 'context-group', id: 'share-zone-form' },
      h('label', { for: 'share-reference-zone', text: 'Reference zone' }),
      zoneInput, zoneApply, zoneList, zoneError,
    );
    zoneForm.addEventListener('submit', function (event) {
      event.preventDefault();
      var candidate = zoneInput.value.trim();
      if (share.zones.indexOf(candidate) === -1) {
        zoneError.textContent = 'Pick a zone from the list.';
        zoneInput.setAttribute('aria-invalid', 'true');
        return;
      }
      zoneError.textContent = '';
      zoneInput.removeAttribute('aria-invalid');
      share.referenceZone = candidate;
      renderGridInto(ui, share.members, share.referenceZone, share.weekStart);
      fetchShareSuggestions();
    });

    ui.weekLabel = h('span', { class: 'week-label' });
    var prevWeek = h('button', { class: 'btn btn-quiet btn-sm', type: 'button', text: '‹', 'aria-label': 'Previous week' });
    var nextWeek = h('button', { class: 'btn btn-quiet btn-sm', type: 'button', text: '›', 'aria-label': 'Next week' });
    var thisWeek = h('button', { class: 'btn btn-quiet btn-sm', type: 'button', text: 'This week' });
    prevWeek.addEventListener('click', function () { share.weekStart = TZ_UTILS.addDays(share.weekStart, -7); renderGridInto(ui, share.members, share.referenceZone, share.weekStart); });
    nextWeek.addEventListener('click', function () { share.weekStart = TZ_UTILS.addDays(share.weekStart, 7); renderGridInto(ui, share.members, share.referenceZone, share.weekStart); });
    thisWeek.addEventListener('click', function () {
      share.weekStart = TZ_UTILS.mondayOf(TZ_UTILS.dateKey(share.referenceZone, Date.now()));
      renderGridInto(ui, share.members, share.referenceZone, share.weekStart);
    });
    var weekNav = h('div', { class: 'context-group' },
      h('span', { class: 'context-label', text: 'Week' }),
      h('div', { class: 'week-nav' }, prevWeek, ui.weekLabel, nextWeek, thisWeek),
    );
    ui.sharedNote = h('span', { class: 'context-note', role: 'status', 'aria-live': 'polite' });
    showContextBar(zoneForm, weekNav, h('div', { class: 'context-spacer' }), ui.sharedNote);

    viewEl.appendChild(
      h('div', { class: 'public-banner' },
        h('span', { class: 'badge badge-accent', text: 'Read-only' }),
        h('span', { text: 'Shared plan — you can explore the grid and slots, but only the team owner can edit members.' }),
      ),
    );
    viewEl.appendChild(
      h('div', { class: 'view-header' },
        h('h1', { text: share.data.team.name }),
        h('span', { class: 'meta', text: (share.members.length || 0) + (share.members.length === 1 ? ' member' : ' members') + ' · updated ' + relativeTime(share.data.team.updatedAt) }),
      ),
    );

    var layout = h('div', { class: 'planner-layout' });

    ui.membersBody = h('div', { class: 'panel-body tight' });
    layout.appendChild(
      h('section', { class: 'panel panel-members', 'aria-labelledby': 'share-members-heading' },
        h('div', { class: 'panel-head' }, h('h2', { id: 'share-members-heading', text: 'Members' })),
        ui.membersBody,
      ),
    );

    ui.gridZoneNote = h('span', { class: 'panel-sub' });
    ui.gridLegend = h('div', { class: 'legend' });
    ui.gridContainer = h('div', { class: 'grid-scroll' });
    layout.appendChild(
      h('section', { class: 'panel panel-grid', 'aria-labelledby': 'share-grid-heading' },
        h('div', { class: 'panel-head' },
          h('h2', { id: 'share-grid-heading', text: 'Overlap this week' }),
          ui.gridZoneNote,
        ),
        ui.gridLegend,
        ui.gridContainer,
      ),
    );

    ui.slotDateInput = h('input', { id: 'share-slot-date', name: 'date', type: 'date', value: share.slotDate, required: true });
    ui.slotDurationInput = h('select', { id: 'share-slot-duration', name: 'duration' },
      h('option', { value: '30', text: '30 min' }),
      h('option', { value: '60', text: '60 min', selected: true }),
      h('option', { value: '90', text: '90 min' }),
    );
    var slotError = h('span', { class: 'field-error', role: 'alert' });
    var slotForm = h('form', { class: 'slot-controls', id: 'share-slot-form' },
      h('div', { class: 'field' }, h('label', { for: 'share-slot-date', text: 'Date' }), ui.slotDateInput),
      h('div', { class: 'field' }, h('label', { for: 'share-slot-duration', text: 'Length' }), ui.slotDurationInput),
      h('button', { class: 'btn btn-primary btn-sm', type: 'submit', text: 'Find slots' }),
      slotError,
    );
    slotForm.addEventListener('submit', function (event) {
      event.preventDefault();
      var date = ui.slotDateInput.value;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        slotError.textContent = 'Pick a date.';
        return;
      }
      slotError.textContent = '';
      share.slotDate = date;
      share.slotDuration = Number(ui.slotDurationInput.value) || 60;
      fetchShareSuggestions();
    });
    ui.slotResults = h('div', { id: 'share-slot-results', 'aria-live': 'polite' });

    layout.appendChild(
      h('section', { class: 'panel panel-slots', 'aria-labelledby': 'share-slots-heading' },
        h('div', { class: 'panel-head' },
          h('h2', { id: 'share-slots-heading', text: 'Meeting slots' }),
          h('span', { class: 'panel-sub', text: 'Every member inside working hours' }),
        ),
        slotForm,
        ui.slotResults,
      ),
    );

    layout.appendChild(
      h('section', { class: 'panel panel-share', 'aria-labelledby': 'share-cta-heading' },
        h('div', { class: 'panel-head' }, h('h2', { id: 'share-cta-heading', text: 'Plan your own' })),
        h('div', { class: 'panel-body' },
          h('p', { class: 'meta', text: 'Zonebuddy is free and self-hosted. Create an account to build teams, track working hours and share plans of your own.' }),
          h('div', { class: 'btn-group share-cta' },
            h('a', { class: 'btn btn-primary', href: '/signup', text: 'Create an account' }),
            h('a', { class: 'btn btn-quiet', href: '/login', text: 'Sign in' }),
          ),
        ),
      ),
    );

    viewEl.appendChild(layout);

    renderShareMembers();
    renderGridInto(ui, share.members, share.referenceZone, share.weekStart);
    renderSlotResults(share.data.suggestions || { slots: [], reason: '' }, ui.slotResults, {
      zone: share.referenceZone,
      onRetry: fetchShareSuggestions,
      onNextDate: function (nextDate) {
        share.slotDate = nextDate;
        ui.slotDateInput.value = nextDate;
        fetchShareSuggestions();
      },
    });
  }

  function renderShareMembers() {
    var share = state.share;
    var ui = share.ui;
    clearTimers();
    clear(ui.membersBody);

    if (!share.members.length) {
      ui.membersBody.appendChild(
        h('div', { class: 'empty-state' },
          h('p', { class: 'empty-title', text: 'No members on this plan yet' }),
          h('p', { class: 'empty-body', text: 'The team owner has not added anyone, so there are no working hours to overlap.' }),
        ),
      );
      return;
    }

    var table = h('table', { class: 'data-table' });
    table.appendChild(
      h('thead', null,
        h('tr', null,
          h('th', { scope: 'col', text: 'Member' }),
          h('th', { scope: 'col', text: 'Working hours' }),
          h('th', { scope: 'col', text: 'Local now' }),
        ),
      ),
    );
    var tbody = h('tbody');
    share.members.forEach(function (member) {
      tbody.appendChild(
        h('tr', null,
          h('td', { 'data-label': 'Member' },
            h('div', { class: 'member-name-cell' },
              h('span', { class: 'swatch ' + swatchClass(member.color) }),
              h('div', { class: 'cell-stack' },
                h('span', { class: 'primary-text', text: member.name }),
                h('span', { class: 'secondary-text', text: member.timeZone }),
              ),
            ),
          ),
          h('td', { 'data-label': 'Working hours' },
            h('div', { class: 'cell-stack' },
              h('span', { class: 'num', text: member.workStart + '–' + member.workEnd }),
              h('span', { class: 'secondary-text', text: TZ_UTILS.zoneAbbr(member.timeZone) }),
            ),
          ),
          h('td', { 'data-label': 'Local now', class: 'num', text: TZ_UTILS.timeLabel(member.timeZone, Date.now()) }),
        ),
      );
    });
    table.appendChild(tbody);
    ui.membersBody.appendChild(h('div', { class: 'table-wrap' }, table));

    var clock = window.setInterval(function () {
      if (!state.share) return;
      var cells = tbody.querySelectorAll('td[data-label="Local now"]');
      cells.forEach(function (node, index) {
        var member = state.share.members[index];
        if (member) node.textContent = TZ_UTILS.timeLabel(member.timeZone, Date.now());
      });
    }, 60000);
    addTimer(clock);
  }

  async function fetchShareSuggestions() {
    var share = state.share;
    if (!share || !share.ui.slotResults) return;
    var requestId = share.request + 1;
    share.request = requestId;
    clear(share.ui.slotResults);
    share.ui.slotResults.appendChild(
      h('div', { class: 'loading-block', role: 'status' },
        h('span', { class: 'sr-only', text: 'Finding meeting slots' }),
        h('div', { class: 'skeleton-row w-60' }),
        h('div', { class: 'skeleton-row w-80' }),
      ),
    );
    var query = new URLSearchParams({
      date: share.slotDate,
      duration: String(share.slotDuration),
      referenceZone: share.referenceZone,
    });
    try {
      var data = await api('/api/share/' + encodeURIComponent(share.token) + '?' + query.toString());
      if (share.request !== requestId) return;
      share.data = data;
      share.members = data.members || share.members;
      share.zones = data.timeZones || share.zones;
      renderGridInto(share.ui, share.members, share.referenceZone, share.weekStart);
      renderSlotResults(data.suggestions || { slots: [], reason: '' }, share.ui.slotResults, {
        zone: share.referenceZone,
        onRetry: fetchShareSuggestions,
        onNextDate: function (nextDate) {
          share.slotDate = nextDate;
          share.ui.slotDateInput.value = nextDate;
          fetchShareSuggestions();
        },
      });
    } catch (error) {
      if (share.request !== requestId) return;
      renderSlotError(share.ui.slotResults, error.message, fetchShareSuggestions);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Boot                                                               */
  /* ------------------------------------------------------------------ */

  renderRoute();
})();
