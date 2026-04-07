/**
 * 예약 생성: POST /api/bookings
 * 결제 완료 처리(클라이언트): POST /api/payments/complete
 * 결제 웹훅(PortOne): POST /webhooks/portone
 * 대기 목록/수동확정(관리자): GET /api/bookings, POST /api/bookings/:id/confirm
 */

function corsHeaders(env) {
  const origin = env.ALLOWED_ORIGIN || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Token',
    'Access-Control-Max-Age': '86400',
  };
}

function withCors(res, env) {
  const h = new Headers(res.headers);
  Object.entries(corsHeaders(env)).forEach(([k, v]) => h.set(k, v));
  return new Response(res.body, { status: res.status, headers: h });
}

function json(data, status, env) {
  return withCors(
    new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    }),
    env,
  );
}

async function readPendingIds(env) {
  const raw = await env.BOOKINGS.get('pending_ids');
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

async function writePendingIds(env, ids) {
  await env.BOOKINGS.put('pending_ids', JSON.stringify(ids));
}

async function appendPending(env, id) {
  const ids = await readPendingIds(env);
  if (!ids.includes(id)) ids.push(id);
  await writePendingIds(env, ids);
}

async function removePending(env, id) {
  const ids = (await readPendingIds(env)).filter((x) => x !== id);
  await writePendingIds(env, ids);
}

function requireAdmin(request, env) {
  const token = request.headers.get('X-Admin-Token') || '';
  if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) return false;
  return true;
}

async function handleCreate(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'JSON 파싱 실패' }, 400, env);
  }

  const customerName = (body.customerName || '').trim();
  const customerPhone = (body.customerPhone || '').trim();
  const reserveDate = (body.reserveDate || '').trim();
  const reserveTime = (body.reserveTime || '').trim();
  const partySize = body.partySize;
  const payMethod = (body.payMethod || '').trim() || '미정';
  const roomName = (body.roomName || '').trim() || null;
  const totalAmount = Number(body.totalAmount || 50000);

  if (!customerName || !customerPhone || !reserveDate || !reserveTime) {
    return json({ error: '이름, 연락처, 날짜, 시간은 필수입니다.' }, 400, env);
  }
  const pax = parseInt(String(partySize), 10);
  if (Number.isNaN(pax) || pax < 1 || pax > 4) {
    return json({ error: '인원은 1~4입니다.' }, 400, env);
  }
  if (!Number.isFinite(totalAmount) || totalAmount <= 0) {
    return json({ error: '결제 금액이 올바르지 않습니다.' }, 400, env);
  }

  const id = crypto.randomUUID();
  const paymentId = `pay-${id}`;
  const createdAt = new Date().toISOString();
  const record = {
    id,
    paymentId,
    status: 'awaiting_payment',
    createdAt,
    customerName,
    customerPhone,
    reserveDate,
    reserveTime,
    partySize: pax,
    totalAmount,
    payMethod,
    roomName,
  };

  await env.BOOKINGS.put(`booking:${id}`, JSON.stringify(record));
  return json(
    {
      ok: true,
      bookingId: id,
      paymentId,
      message: '신청이 생성되었습니다. 결제를 진행해 주세요.',
    },
    200,
    env,
  );
}

async function handleList(request, env) {
  if (!requireAdmin(request, env)) {
    return json({ error: '관리자 토큰이 필요합니다.' }, 401, env);
  }
  const ids = await readPendingIds(env);
  const bookings = [];
  for (const id of ids) {
    const raw = await env.BOOKINGS.get(`booking:${id}`);
    if (!raw) continue;
    try {
      const b = JSON.parse(raw);
      if (b.status === 'pending' || b.status === 'awaiting_payment') bookings.push(b);
    } catch {
      continue;
    }
  }
  bookings.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return json({ ok: true, bookings }, 200, env);
}

function extractPaidAmount(payment) {
  const candidates = [
    payment?.amount?.total,
    payment?.totalAmount,
    payment?.amount,
  ];
  for (const v of candidates) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function extractPaymentStatus(payment) {
  return String(
    payment?.status || payment?.paymentStatus || payment?.state || '',
  ).toUpperCase();
}

async function fetchPortOnePayment(env, paymentId) {
  const secret = (env.PORTONE_API_SECRET || '').trim();
  if (!secret) {
    throw new Error('PORTONE_API_SECRET이 설정되지 않았습니다.');
  }
  const base = (env.PORTONE_API_BASE || 'https://api.portone.io').replace(/\/$/, '');
  const res = await fetch(`${base}/payments/${encodeURIComponent(paymentId)}`, {
    method: 'GET',
    headers: {
      Authorization: `PortOne ${secret}`,
      Accept: 'application/json',
    },
  });
  const text = await res.text();
  let body = {};
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (!res.ok) {
    throw new Error(`PortOne 조회 실패(${res.status}): ${JSON.stringify(body)}`);
  }
  return body && body.payment ? body.payment : body;
}

async function forwardToHome(booking, env) {
  const homeUrl = (env.HOME_SERVER_URL || '').trim().replace(/\/$/, '');
  const ingestSecret = (env.BOOKING_INGEST_SECRET || '').trim();
  if (!homeUrl || !ingestSecret) {
    return { ok: false, error: 'Worker에 HOME_SERVER_URL 또는 BOOKING_INGEST_SECRET이 설정되지 않았습니다.' };
  }
  const payload = {
    booking_id: booking.id,
    customer_name: booking.customerName,
    customer_phone: booking.customerPhone,
    reserve_date: booking.reserveDate,
    reserve_time: booking.reserveTime,
    party_size: booking.partySize,
    pay_method: booking.payMethod,
  };
  if (booking.roomName) payload.room_name = booking.roomName;
  try {
    const homeRes = await fetch(`${homeUrl}/api/ingest/booking`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ingestSecret}`,
      },
      body: JSON.stringify(payload),
    });
    const homeText = await homeRes.text();
    let homeJson;
    try { homeJson = JSON.parse(homeText); } catch { homeJson = { raw: homeText }; }
    if (!homeRes.ok) {
      return { ok: false, error: '집 서버가 예약을 거절했습니다.', status: homeRes.status, home: homeJson };
    }
    return { ok: true, reservationId: homeJson.reservation_id ?? null };
  } catch (e) {
    return { ok: false, error: '집 서버 연결 실패', detail: String(e) };
  }
}

async function finalizeBookingIfPaid(env, bookingId, paymentId, source) {
  const raw = await env.BOOKINGS.get(`booking:${bookingId}`);
  if (!raw) return { ok: false, code: 404, error: '예약을 찾을 수 없습니다.' };
  let booking;
  try { booking = JSON.parse(raw); } catch { return { ok: false, code: 500, error: '예약 데이터 오류' }; }
  if (booking.status === 'confirmed') return { ok: true, alreadyConfirmed: true, booking };
  if (booking.paymentId && booking.paymentId !== paymentId) {
    return { ok: false, code: 400, error: 'paymentId가 예약과 일치하지 않습니다.' };
  }

  const payment = await fetchPortOnePayment(env, paymentId);
  const status = extractPaymentStatus(payment);
  const paidAmount = extractPaidAmount(payment);
  if (paidAmount == null) {
    return { ok: false, code: 502, error: '결제 금액 확인에 실패했습니다.' };
  }
  if (Number(paidAmount) !== Number(booking.totalAmount)) {
    return { ok: false, code: 400, error: `결제 금액 불일치 (${paidAmount} != ${booking.totalAmount})` };
  }

  // 카드: PAID 일 때만 확정. 가상계좌: 입금 전엔 VIRTUAL_ACCOUNT_ISSUED 상태일 수 있음.
  if (status !== 'PAID') {
    booking.paymentStatus = status;
    booking.lastPaymentCheckedAt = new Date().toISOString();
    await env.BOOKINGS.put(`booking:${booking.id}`, JSON.stringify(booking));
    return { ok: false, code: 409, notPaidYet: true, status };
  }

  const forward = await forwardToHome(booking, env);
  if (!forward.ok) {
    return { ok: false, code: 502, ...forward };
  }

  booking.status = 'confirmed';
  booking.paymentStatus = status;
  booking.confirmSource = source;
  booking.confirmedAt = new Date().toISOString();
  booking.reservationId = forward.reservationId;
  await env.BOOKINGS.put(`booking:${booking.id}`, JSON.stringify(booking));
  await removePending(env, booking.id);

  return { ok: true, booking };
}

async function handlePaymentComplete(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'JSON 파싱 실패' }, 400, env); }
  const bookingId = String(body.bookingId || '').trim();
  const paymentId = String(body.paymentId || '').trim();
  if (!bookingId || !paymentId) return json({ error: 'bookingId, paymentId가 필요합니다.' }, 400, env);

  try {
    const result = await finalizeBookingIfPaid(env, bookingId, paymentId, 'client');
    if (!result.ok && result.notPaidYet) {
      return json(
        {
          ok: true,
          pending: true,
          message: '결제는 생성되었지만 아직 입금 완료 상태가 아닙니다. 입금 완료 후 자동 반영됩니다.',
          paymentStatus: result.status,
        },
        200,
        env,
      );
    }
    if (!result.ok) return json({ error: result.error, status: result.status, home: result.home }, result.code || 500, env);
    return json({ ok: true, message: '결제가 확인되어 예약이 확정되었습니다.', reservationId: result.booking.reservationId }, 200, env);
  } catch (e) {
    return json({ error: '결제 검증 실패', detail: String(e) }, 502, env);
  }
}

async function handlePortOneWebhook(request, env) {
  // 현재는 웹훅 비밀 검증보다 "PortOne API 재조회"를 신뢰 기준으로 사용.
  // 운영 전 서명 검증 헤더 규격 확정 시 검증 로직 추가 권장.
  let body = {};
  const ct = (request.headers.get('Content-Type') || '').toLowerCase();
  if (ct.includes('application/json')) {
    body = await request.json().catch(() => ({}));
  } else if (ct.includes('application/x-www-form-urlencoded')) {
    const fd = await request.formData();
    body = Object.fromEntries(fd.entries());
  } else {
    const text = await request.text();
    try { body = JSON.parse(text); } catch { body = {}; }
  }

  const paymentId = String(body.paymentId || body.id || body.payment_id || '').trim();
  if (!paymentId) return json({ ok: true, ignored: true, reason: 'paymentId 없음' }, 200, env);

  // 예약 id는 paymentId("pay-<bookingId>")에서 복원
  const bookingId = paymentId.startsWith('pay-') ? paymentId.slice(4) : '';
  if (!bookingId) return json({ ok: true, ignored: true, reason: 'bookingId 복원 실패' }, 200, env);

  try {
    const result = await finalizeBookingIfPaid(env, bookingId, paymentId, 'webhook');
    if (!result.ok && result.notPaidYet) {
      return json({ ok: true, pending: true, paymentStatus: result.status }, 200, env);
    }
    if (!result.ok) {
      return json({ ok: true, ignored: true, reason: result.error }, 200, env);
    }
    return json({ ok: true, confirmed: true, reservationId: result.booking.reservationId }, 200, env);
  } catch (e) {
    return json({ ok: true, ignored: true, reason: String(e) }, 200, env);
  }
}

async function handleConfirm(request, env, id) {
  if (!requireAdmin(request, env)) {
    return json({ error: '관리자 토큰이 필요합니다.' }, 401, env);
  }

  const raw = await env.BOOKINGS.get(`booking:${id}`);
  if (!raw) return json({ error: '예약을 찾을 수 없습니다.' }, 404, env);

  let booking;
  try {
    booking = JSON.parse(raw);
  } catch {
    return json({ error: '데이터 오류' }, 500, env);
  }

  if (booking.status !== 'pending') {
    return json({ error: '이미 처리된 예약입니다.', status: booking.status }, 400, env);
  }

  const homeUrl = (env.HOME_SERVER_URL || '').trim().replace(/\/$/, '');
  const ingestSecret = (env.BOOKING_INGEST_SECRET || '').trim();
  if (!homeUrl || !ingestSecret) {
    return json({ error: 'Worker에 HOME_SERVER_URL 또는 BOOKING_INGEST_SECRET이 설정되지 않았습니다.' }, 503, env);
  }

  const payload = {
    booking_id: booking.id,
    customer_name: booking.customerName,
    customer_phone: booking.customerPhone,
    reserve_date: booking.reserveDate,
    reserve_time: booking.reserveTime,
    party_size: booking.partySize,
    pay_method: booking.payMethod,
  };
  if (booking.roomName) payload.room_name = booking.roomName;

  let homeRes;
  try {
    homeRes = await fetch(`${homeUrl}/api/ingest/booking`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ingestSecret}`,
      },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    return json({ error: '집 서버 연결 실패', detail: String(e) }, 502, env);
  }

  const homeText = await homeRes.text();
  let homeJson;
  try {
    homeJson = JSON.parse(homeText);
  } catch {
    homeJson = { raw: homeText };
  }

  if (!homeRes.ok) {
    return json(
      {
        error: '집 서버가 예약을 거절했습니다.',
        status: homeRes.status,
        home: homeJson,
      },
      502,
      env,
    );
  }

  booking.status = 'confirmed';
  booking.confirmedAt = new Date().toISOString();
  booking.reservationId = homeJson.reservation_id ?? null;
  await env.BOOKINGS.put(`booking:${id}`, JSON.stringify(booking));
  await removePending(env, id);

  return json(
    {
      ok: true,
      message: '예약이 집 서버에 반영되었습니다.',
      reservationId: homeJson.reservation_id,
    },
    200,
    env,
  );
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return withCors(new Response(null, { status: 204 }), env);
    }

    const url = new URL(request.url);
    let path = url.pathname;
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);

    try {
      if (path === '/api/bookings' && request.method === 'POST') {
        return handleCreate(request, env);
      }
      if (path === '/api/bookings' && request.method === 'GET') {
        return handleList(request, env);
      }
      if (path === '/api/payments/complete' && request.method === 'POST') {
        return handlePaymentComplete(request, env);
      }
      if (path === '/webhooks/portone' && request.method === 'POST') {
        return handlePortOneWebhook(request, env);
      }
      const confirmPrefix = '/api/bookings/';
      const confirmSuffix = '/confirm';
      if (
        path.startsWith(confirmPrefix) &&
        path.endsWith(confirmSuffix) &&
        request.method === 'POST'
      ) {
        const id = path.slice(confirmPrefix.length, -confirmSuffix.length);
        if (!id) return json({ error: 'not found' }, 404, env);
        return handleConfirm(request, env, id);
      }

      if (path === '/api/health' && request.method === 'GET') {
        return json({ ok: true }, 200, env);
      }

      return json({ error: 'not found' }, 404, env);
    } catch (e) {
      return json({ error: '서버 오류', detail: String(e) }, 500, env);
    }
  },
};
