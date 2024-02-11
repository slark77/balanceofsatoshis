const asyncAuto = require('async/auto');
const {connectPeer} = require('ln-sync');
const {formatTokens} = require('ln-sync');
const {getNodeAlias} = require('ln-sync');
const {parsePaymentRequest} = require('ln-service');
const {returnResult} = require('asyncjs-util');

const {defaultLifetimeBlocks} = require('./constants');
const makeRequest = require('./make_request');
const {methodCreateOrder} = require('./lsps1_protocol');
const {methodGetInfo} = require('./lsps1_protocol');
const {methodGetOrder} = require('./lsps1_protocol');
const {probeDestination} = require('./../network');
const {versionJsonRpc} = require('./lsps1_protocol');

const displayTokens = tokens => formatTokens({tokens}).display;
const hoursAsBlocks = hours => hours * 6;
const isAnnounced = type => type === 'public';
const isNumber = n => !!n && !isNaN(n);
const isOutpoint = n => !!n && /^[0-9A-F]{64}:[0-9]{1,6}$/i.test(n);
const isPublicKey = n => !!n && /^0[2-3][0-9A-F]{64}$/i.test(n);
const knownTypes = ['private', 'public'];
const niceAlias = n => `${(n.alias || n.id).trim()} ${n.id.substring(0, 8)}`;
const split = n => n.split(':');

/** LSPS1 Client: Purchase an inbound channel open attempt

  LSPS1: https://github.com/BitcoinAndLightningLayerSpecs/lsp/tree/main/LSPS1

  {
    ask: <Ask Function>
    capacity: <Inbound Channel Capacity Tokens Number>
    fs: {
      getFile: <Read File Contents Function> (path, cbk) => {}
    }
    [is_dry_run]: <Get Channel Price Quote Only Bool>
    lnd: <Authenticated LND API Object>
    logger: <Winston Logger Object>
    max_wait_hours: <Requested Maximum Channel Open Wait Hours Count Number>
    [recovery]: <Existing Order Recovery String>
    service_node: <Provider Service Node Identity Public Key Hex String>
    type: <Inbound Channel Type String>
  }

  @returns via cbk or Promise
*/
module.exports = (args, cbk) => {
  return new Promise((resolve, reject) => {
    return asyncAuto({
      // Check arguments
      validate: cbk => {
        if (!args.ask) {
          return cbk([400, 'ExpectedInquirerFunctionForLsp1Client']);
        }

        if (!args.fs) {
          return cbk([400, 'ExpectedFileSystemObjectForLsp1Client']);
        }

        if (!!args.is_dry_run && !!args.recovery) {
          return cbk([400, 'DryRunNotSupportedWithRecoveryMode']);
        }

        if (!args.lnd) {
          return cbk([400, 'ExpectedAuthenticatedLndForLsp1Client']);
        }

        if (!args.logger) {
          return cbk([400, 'ExpectedWinstonLoggerForLsp1Client']);
        }

        if (!args.service_node || !isPublicKey(args.service_node)) {
          return cbk([400, 'ExpectedValidServiceNodeHexPubkeyForLsp1Client']);
        }

        // Exit early when this is a recovery scenario
        if (!!args.recovery) {
          return cbk();
        }

        if (!isNumber(args.capacity)) {
          return cbk([400, 'ExpectedChannelCapacityAmountForLsp1Client']);
        }

        if (!isNumber(args.max_wait_hours)) {
          return cbk([400, 'ExpectedMaxOpenWaitHoursForLsp1Client']);
        }

        if (!args.type) {
          return cbk([400, 'ExpectedOpenChannelTypeForLsp1Client']);
        }

        if (!knownTypes.includes(args.type)) {
          return cbk([400, 'ExpectedKnownChannelTypeForLsp1Client']);
        }

        return cbk();
      },

      // Get the alias of the service node
      getAlias: ['validate', ({}, cbk) => {
        return getNodeAlias({id: args.service_node, lnd: args.lnd}, cbk);
      }],

      // Connect to the service node
      connect: ['getAlias', ({getAlias}, cbk) => {
        const node = `${getAlias.id} ${getAlias.alias}`;

        // It may take a while to establish a connection with the peer
        args.logger.info({connecting_to: node});

        return connectPeer({id: args.service_node, lnd: args.lnd}, cbk);
      }],

      // Get the limits of the channel open service
      getLimits: ['connect', ({}, cbk) => {
        // Exit early when recovering
        if (!!args.recovery) {
          return cbk();
        }

        args.logger.info({
          requesting_inbound_channel_capacity: displayTokens(args.capacity),
        });

        return makeRequest({
          lnd: args.lnd,
          method: methodGetInfo,
          service: args.service_node,
        },
        cbk);
      }],

      // Validate and format the limits
      limits: ['getLimits', ({getLimits}, cbk) => {
        // Exit early when recovering
        if (!!args.recovery) {
          return cbk();
        }

        if (!getLimits.response || !getLimits.response.options) {
          return cbk([503, 'ExpectedLimitsInLsps1ServiceResponse']);
        }

        const {options} = getLimits.response;

        if (!!Number(options.min_initial_client_balance_sat)) {
          return cbk([501, 'Lsps1PushBalanceNotSupported']);
        }

        const maxCapacity = Number(options.max_channel_balance_sat);
        const minimumCapacity = Number(options.min_channel_balance_sat);

        // Make sure the requested capacity is at least the minimum
        if (args.capacity < minimumCapacity) {
          return cbk([400, 'RequestedCapacityTooLow', {min: minimumCapacity}]);
        }

        // Make sure the requested capacity isn't more than the maximum
        if (args.capacity > maxCapacity) {
          return cbk([400, 'RequestedCapacityTooHigh', {max: maxCapacity}]);
        }

        args.logger.info({
          service_limits: {
            minimum_capacity: displayTokens(minimumCapacity),
            maximum_capacity: displayTokens(maxCapacity),
          },
          website: getLimits.response.website || undefined,
        });

        return cbk();
      }],

      // Get a price quote
      getQuote: ['getAlias', 'limits', ({getAlias}, cbk) => {
        // Exit early when recovering
        if (!!args.recovery) {
          return cbk();
        }

        args.logger.info({estimating_routing_fee_to: niceAlias(getAlias)});

        return makeRequest({
          lnd: args.lnd,
          method: methodCreateOrder,
          params: {
            announce_channel: isAnnounced(args.type),
            channel_expiry_blocks: defaultLifetimeBlocks,
            client_balance_sat: Number().toString(),
            confirms_within_blocks: hoursAsBlocks(args.max_wait_hours),
            lsp_balance_sat: args.capacity.toString(),
            token: String(),
          },
          service: args.service_node,
        },
        cbk);
      }],

      // Check the price quote
      quote: ['getQuote', ({getQuote}, cbk) => {
        // Exit early when recovering
        if (!!args.recovery) {
          return cbk(null, {id: args.recovery});
        }

        if (!getQuote.response || !getQuote.response.payment) {
          return cbk([503, 'UnexpectedMissingQuoteInLsps1OpenQuoteResponse']);
        }

        if (!getQuote.response.order_id) {
          return cbk([503, 'UnexpectedAbsentOrderIdInLsps1OpenQuoteResponse']);
        }

        const request = getQuote.response.payment.lightning_invoice;

        if (!request) {
          return cbk([503, 'UnexpectedMissingPaymentRequestInQuoteResponse']);
        }

        try {
          parsePaymentRequest({request});
        } catch (err) {
          return cbk([503, 'UnexpectedInvalidPayReqInQuoteResponse', {err}]);
        }

        return cbk(null, {
          request,
          id: getQuote.response.order_id,
        });
      }],

      // Probe to determine the routing fee
      getFee: ['quote', ({quote}, cbk) => {
        // Exit early when recovering
        if (!!args.recovery) {
          return cbk();
        }

        return probeDestination({
          fs: args.fs,
          lnd: args.lnd,
          logger: args.logger,
          request: quote.request,
        },
        cbk);
      }],

      // Confirm payment
      accept: ['getFee', 'quote', ({getFee, quote}, cbk) => {
        // Exit early when recovering
        if (!!args.recovery) {
          return cbk();
        }

        const capacity = displayTokens(args.capacity);
        const displayTotal = displayTokens(getFee.probed + getFee.fee);

        args.logger.info({
          order: {
            recovery_id: quote.id,
            payment_request: quote.request,
            opening_fee: displayTokens(getFee.probed),
            routing_fee: displayTokens(getFee.fee).trim() || undefined,
            overall_fee: !!getFee.fee ? displayTotal : undefined,
          },
        });

        // Exit early when this is a dry run and nothing will be paid
        if (args.is_dry_run) {
          return cbk();
        }

        return args.ask({
          default: true,
          message: `Pay ${displayTotal} to get ${capacity} inbound channel?`,
          name: 'ok',
          type: 'confirm',
        },
        ({ok}) => {
          if (!ok) {
            return cbk([400, 'PurchaseChannelPriceNotAccepted']);
          }

          return cbk();
        });
      }],

      // Make the payment
      pay: ['accept', 'getFee', 'quote', ({getFee, quote}, cbk) => {
        // Exit early when recovering
        if (!!args.recovery) {
          return cbk();
        }

        // Exit early and do not pay when this is a dry run
        if (args.is_dry_run) {
          args.logger.info({is_dry_run: true});

          return cbk();
        }

        return probeDestination({
          fs: args.fs,
          is_real_payment: true,
          lnd: args.lnd,
          logger: args.logger,
          max_fee: getFee.fee,
          request: quote.request,
        },
        cbk);
      }],

      // Ask for order status
      getOrder: ['pay', 'quote', ({pay, quote}, cbk) => {
        // Exit early when there was no real order
        if (!!args.is_dry_run) {
          return cbk();
        }

        if (!args.recovery && !!pay) {
          args.logger.info({
            paid: displayTokens(pay.paid),
            payment_id: pay.id,
            payment_proof_preimage: pay.preimage,
          });
        }

        args.logger.info({requesting_order_status: quote.id});

        return makeRequest({
          lnd: args.lnd,
          method: methodGetOrder,
          params: {order_id: quote.id},
          service: args.service_node,
        },
        cbk);
      }],

      order: ['getOrder', ({getOrder}, cbk) => {
        // Exit early when there was no real order
        if (!!args.is_dry_run) {
          return cbk();
        }

        if (!getOrder.response || !getOrder.response.payment) {
          return cbk([503, 'UnexpectedMissingResponseForGetOrderInfo']);
        }

        if (!getOrder.response.payment.state) {
          return cbk([503, 'UnexpectedPaymentStateInGetOrderInfoResponse']);
        }

        const {state} = getOrder.response.payment;

        // Exit early when there is no channel
        if (!getOrder.response.channel) {
          args.logger.info({order_status: state});

          return cbk();
        }

        if (!isOutpoint(getOrder.response.channel.funding_outpoint)) {
          return cbk([503, 'UnexpectedChannelFundingOutpointInResponse']);
        }

        const [id, vout] = split(getOrder.response.channel.funding_outpoint);

        args.logger.info({
          transaction_id: id,
          transaction_output_index: vout,
          order_status: getOrder.response.payment.state,
        });

        return cbk();
      }],
    },
    returnResult({reject, resolve}, cbk));
  });
};