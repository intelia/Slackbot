'use strict';

// Maximum allowed ± difference when adjusting the payment search amount.
// e.g. 1000 means the CSR can enter -1000 to +1000.
const PAYMENT_ADJUSTMENT_LIMIT = 1000;

module.exports = { PAYMENT_ADJUSTMENT_LIMIT };
