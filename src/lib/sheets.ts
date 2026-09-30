/**
 * Google Sheets API Helper for SSPL S3 Cricket Tournament
 */

export const TOURNAMENT_HEADERS = [
  'Full Name',
  'Email',
  'Contact Number',
  'Age',
  'Batting Style',
  'Batting Position',
  'Bowling Style',
  'Primary Field Role',
  'Career Details',
  'Jersey Size',
  'Jersey Name',
  'Jersey Number',
  'Registered At'
];

export interface PlayerRecord {
  fullName?: string;
  email?: string;
  userEmail?: string;
  contactNumber?: string;
  age?: string | number;
  battingStyle?: string;
  battingPosition?: string;
  bowlingStyle?: string;
  primaryFieldRole?: string;
  careerDetails?: string;
  jerseySize?: string;
  jerseyName?: string;
  jerseyNumber?: string | number;
  createdAt?: any;
}

export const formatPlayerRow = (p: PlayerRecord): any[] => {
  let dateStr = '';
  if (p.createdAt) {
    if (typeof p.createdAt.toDate === 'function') {
      dateStr = p.createdAt.toDate().toLocaleString();
    } else if (p.createdAt.seconds) {
      dateStr = new Date(p.createdAt.seconds * 1000).toLocaleString();
    } else {
      dateStr = new Date(p.createdAt).toLocaleString();
    }
  } else {
    dateStr = new Date().toLocaleString();
  }

  return [
    p.fullName || '',
    p.email || p.userEmail || '',
    p.contactNumber || '',
    p.age || '',
    p.battingStyle || '',
    p.battingPosition || '',
    p.bowlingStyle || '',
    p.primaryFieldRole || '',
    p.careerDetails || '',
    p.jerseySize || '',
    p.jerseyName || '',
    p.jerseyNumber !== undefined && p.jerseyNumber !== null ? String(p.jerseyNumber) : '',
    dateStr
  ];
};

/**
 * Creates a new dedicated Google Sheet for the tournament roster
 */
export const createTournamentSpreadsheet = async (
  oauthToken: string,
  title: string = 'SSPL S3 - Tournament Players Roster'
): Promise<{ spreadsheetId: string; spreadsheetUrl: string }> => {
  const response = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${oauthToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      properties: {
        title
      },
      sheets: [
        {
          properties: {
            title: 'Players',
            gridProperties: {
              frozenRowCount: 1,
              columnCount: 15
            }
          }
        }
      ]
    })
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error?.message || `Failed to create Google Sheet (${response.status})`);
  }

  const data = await response.json();
  const spreadsheetId = data.spreadsheetId;
  const spreadsheetUrl = data.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;

  // Write headers to the new sheet
  await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/Players!A1:M1?valueInputOption=USER_ENTERED`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${oauthToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      values: [TOURNAMENT_HEADERS]
    })
  });

  // Format header row: Crimson background (#410001), bold white text
  try {
    await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${oauthToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        requests: [
          {
            repeatCell: {
              range: {
                sheetId: data.sheets?.[0]?.properties?.sheetId || 0,
                startRowIndex: 0,
                endRowIndex: 1,
                startColumnIndex: 0,
                endColumnIndex: TOURNAMENT_HEADERS.length
              },
              cell: {
                userEnteredFormat: {
                  backgroundColor: { red: 0.255, green: 0, blue: 0.004 }, // #410001
                  horizontalAlignment: 'CENTER',
                  textFormat: {
                    foregroundColor: { red: 1, green: 1, blue: 1 },
                    fontSize: 11,
                    bold: true
                  }
                }
              },
              fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)'
            }
          },
          {
            autoResizeDimensions: {
              dimensions: {
                sheetId: data.sheets?.[0]?.properties?.sheetId || 0,
                dimension: 'COLUMNS',
                startIndex: 0,
                endIndex: TOURNAMENT_HEADERS.length
              }
            }
          }
        ]
      })
    });
  } catch (fmtErr) {
    console.warn('Could not apply header styling, continuing:', fmtErr);
  }

  return { spreadsheetId, spreadsheetUrl };
};

/**
 * Fetches the title of the first sheet in the spreadsheet
 */
export const getFirstSheetTitle = async (oauthToken: string, spreadsheetId: string): Promise<string> => {
  try {
    const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties.title`, {
      headers: { Authorization: `Bearer ${oauthToken}` }
    });
    if (res.ok) {
      const data = await res.json();
      if (data.sheets && data.sheets.length > 0 && data.sheets[0].properties?.title) {
        return data.sheets[0].properties.title;
      }
    }
  } catch (e) {
    console.warn('Could not get sheet metadata:', e);
  }
  return 'Players';
};

export const formatTournamentSheet = async (oauthToken: string, spreadsheetId: string) => {
  try {
    const metaRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties`, {
      headers: { Authorization: `Bearer ${oauthToken}` }
    });
    if (!metaRes.ok) return;
    const metaData = await metaRes.json();
    const sheetId = metaData.sheets?.[0]?.properties?.sheetId || 0;

    await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${oauthToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        requests: [
          {
            repeatCell: {
              range: {
                sheetId,
                startRowIndex: 0,
                endRowIndex: 1,
                startColumnIndex: 0,
                endColumnIndex: TOURNAMENT_HEADERS.length
              },
              cell: {
                userEnteredFormat: {
                  backgroundColor: { red: 0.255, green: 0, blue: 0.004 }, // #410001
                  horizontalAlignment: 'CENTER',
                  textFormat: {
                    foregroundColor: { red: 1, green: 1, blue: 1 },
                    fontSize: 11,
                    bold: true
                  }
                }
              },
              fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)'
            }
          },
          {
            autoResizeDimensions: {
              dimensions: {
                sheetId,
                dimension: 'COLUMNS',
                startIndex: 0,
                endIndex: TOURNAMENT_HEADERS.length
              }
            }
          }
        ]
      })
    });
  } catch (err) {
    console.warn('Formatting warning:', err);
  }
};

/**
 * Appends a single player registration to the Google Sheet
 */
export const appendPlayerToSpreadsheet = async (
  oauthToken: string,
  spreadsheetId: string,
  player: PlayerRecord
) => {
  const sheetTitle = await getFirstSheetTitle(oauthToken, spreadsheetId);
  const row = formatPlayerRow(player);
  const range = `'${sheetTitle}'!A:M`;
  
  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${oauthToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        values: [row]
      })
    }
  );

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error?.message || `Failed to append row to Google Sheet (${response.status})`);
  }

  return await response.json();
};

/**
 * Syncs the entire players list into the Google Sheet
 */
export const syncAllPlayersToSpreadsheet = async (
  oauthToken: string,
  spreadsheetId: string,
  players: PlayerRecord[]
) => {
  const sheetTitle = await getFirstSheetTitle(oauthToken, spreadsheetId);
  const rows = [TOURNAMENT_HEADERS, ...players.map(formatPlayerRow)];

  // 1. Clear existing values from row 1 downwards to ensure exact sync
  try {
    await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/'${encodeURIComponent(sheetTitle)}'!A1:Z:clear`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${oauthToken}`,
          'Content-Type': 'application/json'
        }
      }
    );
  } catch (clearErr) {
    console.warn('Clear notice:', clearErr);
  }

  // 2. Put all rows starting at A1
  const range = `'${sheetTitle}'!A1`;
  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${oauthToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        values: rows
      })
    }
  );

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error?.message || `Failed to sync players to Google Sheet (${response.status})`);
  }

  // 3. Ensure header styling & auto column width
  await formatTournamentSheet(oauthToken, spreadsheetId);

  return await response.json();
};
