module.exports = {
  // Freshdesk ticket status codes
  FD_STATUS: {
    OPEN:     2,
    PENDING:  3,
    RESOLVED: 4,
    CLOSED:   5,
  },

  // TravelAdvantage base URL
  TA_BASE: process.env.TA_BASE_URL || 'https://www.traveladvantage.com',

  // Prewarm: tickets with more conversations than this threshold are skipped
  PREWARM_CONVERSATION_THRESHOLD: 2,
};
