// 관세청 관세환율정보 프록시 서버
// 브라우저에서 직접 호출하면 CORS에 막히고 인증키도 노출되기 때문에,
// 이 서버가 인증키를 들고 관세청 API를 대신 호출한 뒤 결과만 JSON으로 돌려줍니다.
//
// 실행 방법
//   1) Node.js 18 이상 설치 (전역 fetch 내장)
//   2) 터미널에서: CUSTOMS_API_KEY="여기에_Decoding_인증키" node server.js
//      (환경변수로 안 넘기면 아래 SERVICE_KEY 자리에 직접 채워도 됩니다 - 단, 이 파일을
//       깃허브 등 외부에 올릴 때는 키를 지우고 올리세요)
//   3) http://localhost:3001/api/customs-rate 로 접속해 JSON이 뜨는지 확인

const http = require('http');

// 공공데이터포털에서 받은 "Decoding(복호화)" 키를 넣으세요.
// encodeURIComponent를 직접 해주므로 인코딩된 키가 아니라 디코딩된 원본 키를 써야 합니다.
const SERVICE_KEY = process.env.CUSTOMS_API_KEY || '여기에_DECODING_인증키_입력';

const BASE_URL = 'http://apis.data.go.kr/1220000/retrieveTrifFxrtInfo/getRetrieveTrifFxrtInfo';

function formatDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

// 관세청 API가 XML로 응답하므로, <item> 블록만 간단히 정규식으로 파싱합니다.
function parseXml(xml) {
  const get = (block, tag) => {
    const m = block.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
    return m ? m[1] : null;
  };
  const items = (xml.match(/<item>([\s\S]*?)<\/item>/g) || []).map((block) => ({
    cntySgn: get(block, 'cntySgn'),
    mtryUtNm: get(block, 'mtryUtNm'),
    fxrt: get(block, 'fxrt'),
    currSgn: get(block, 'currSgn'),
    aplyBgnDt: get(block, 'aplyBgnDt'),
    imexTp: get(block, 'imexTp'),
  }));
  const resultCodeMatch = xml.match(/<resultCode>([^<]*)<\/resultCode>/);
  const resultMsgMatch = xml.match(/<resultMsg>([^<]*)<\/resultMsg>/);
  return {
    resultCode: resultCodeMatch ? resultCodeMatch[1] : null,
    resultMsg: resultMsgMatch ? resultMsgMatch[1] : null,
    items,
  };
}

async function fetchRateForDate(dateStr, weekFxrtTpcd) {
  const url = `${BASE_URL}?serviceKey=${encodeURIComponent(SERVICE_KEY)}&aplyBgnDt=${dateStr}&weekFxrtTpcd=${weekFxrtTpcd}`;
  const res = await fetch(url);
  const xml = await res.text();
  return parseXml(xml);
}

// 관세환율은 "주간" 고시라서 정확한 적용개시일자를 맞춰야 결과가 나옵니다.
// 오늘부터 최대 maxDaysBack일을 거슬러 올라가며 값이 나오는 가장 최근 날짜를 찾습니다.
async function findLatestRates(weekFxrtTpcd, maxDaysBack = 10) {
  const today = new Date();
  for (let i = 0; i < maxDaysBack; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateStr = formatDate(d);
    const { resultCode, resultMsg, items } = await fetchRateForDate(dateStr, weekFxrtTpcd);
    if (resultCode === '00' && items.length > 0) {
      return { date: dateStr, items };
    }
    if (resultCode && resultCode !== '00' && i === 0) {
      // 인증키 오류 등은 날짜를 바꿔도 동일하게 실패하므로 바로 알려줍니다.
      console.warn(`[customs-rate] resultCode=${resultCode} msg=${resultMsg}`);
    }
  }
  return { date: null, items: [] };
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url.startsWith('/api/customs-rate')) {
    try {
      // weekFxrtTpcd: 1=수출, 2=수입 (구매대행은 수입이므로 2)
      const { date, items } = await findLatestRates(2);
      const jpy = items.find((it) => it.currSgn === 'JPY');
      const usd = items.find((it) => it.currSgn === 'USD');

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          aplyBgnDt: date,
          jpy: jpy ? Number(jpy.fxrt) : null,
          usd: usd ? Number(usd.fxrt) : null,
        })
      );
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found. Try /api/customs-rate');
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`관세환율 프록시 서버 실행 중: http://localhost:${PORT}/api/customs-rate`);
});
