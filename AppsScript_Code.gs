const SPREADSHEET_ID = "16bpY3mbrs4dFwfBoHElNBwX0yNgjM5MjWZiYMJ_PhiA";

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    if (!data || !data.data) throw new Error("Invalid payload");

    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    let sheet = ss.getSheetByName("SOL_Data");
    if (!sheet) sheet = ss.insertSheet("SOL_Data");

    sheet.clearContents();

    const rows = [[
      "週期","Close","EMA20","EMA50","EMA200",
      "RSI14","RSI狀態","趨勢","更新時間","資料來源"
    ]];

    ["4h","1h","30m","15m"].forEach(tf => {
      const x = data.data[tf];
      rows.push([
        tf,x.close,x.ema20,x.ema50,x.ema200,
        x.rsi14,x.rsiState,x.trend,data.updatedAt,x.source || data.source || ""
      ]);
    });

    sheet.getRange(1,1,rows.length,rows[0].length).setValues(rows);
    sheet.setFrozenRows(1);

    return ContentService
      .createTextOutput(JSON.stringify({ok:true,message:"SOL indicators saved",updatedAt:data.updatedAt}))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ok:false,error:err.message}))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
