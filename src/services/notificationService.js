const { getMessaging } = require('../config/firebase');
const { Cart, DeviceToken, GuestDevice, Notification, User } = require('../models');
const { renderTemplate, normalizeLanguage } = require('../utils/notificationTemplates');

function normalizeFcmData(data = {}) {
  return Object.fromEntries(
    Object.entries(data)
      .filter(([, value]) => value !== null && value !== undefined)
      .map(([key, value]) => [key, value instanceof Date ? value.toISOString() : String(value)])
  );
}

const FCM_BATCH_SIZE = 500;
// Errors meaning the app was uninstalled or the token is no longer valid.
const DEAD_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);
// Errors meaning the token was never a real one for this app (made up, or
// from another Firebase project). Only phones that aren't signed in are
// removed for these: anyone can add one through the public guest-token route.
const BAD_GUEST_TOKEN_CODES = new Set([
  'messaging/invalid-argument',
  'messaging/mismatched-credential',
]);

class NotificationService {
  constructor() {
    this.messaging = null;
  }

  getMessagingInstance() {
    if (!this.messaging) {
      this.messaging = getMessaging();
    }
    return this.messaging;
  }

  async sendToDevice(fcmToken, notification, data = {}) {
    const messaging = this.getMessagingInstance();
    if (!messaging) {
      console.warn('FCM not configured, skipping notification');
      return null;
    }

    try {
      const message = {
        token: fcmToken,
        notification: {
          title: notification.title,
          body: notification.body,
          ...(notification.imageUrl && { imageUrl: notification.imageUrl }),
        },
        data: {
          ...normalizeFcmData(data),
          click_action: 'FLUTTER_NOTIFICATION_CLICK',
        },
        android: {
          priority: 'high',
          notification: {
            channelId: 'veepee_default',
            priority: 'high',
            defaultSound: true,
          },
        },
        apns: {
          payload: {
            aps: {
              sound: 'default',
              badge: 1,
            },
          },
        },
      };

      const response = await messaging.send(message);
      console.log('Notification sent successfully:', response);
      return response;
    } catch (error) {
      console.error('Error sending notification:', error);
      // If token is invalid, we might want to remove it from database
      if (error.code === 'messaging/invalid-registration-token' ||
          error.code === 'messaging/registration-token-not-registered') {
        await this.removeInvalidToken(fcmToken);
      }
      throw error;
    }
  }

  async sendToMultipleDevices(fcmTokens, notification, data = {}) {
    const messaging = this.getMessagingInstance();
    if (!messaging) {
      console.warn('FCM not configured, skipping notification');
      return null;
    }

    if (!fcmTokens || fcmTokens.length === 0) {
      return { successCount: 0, failureCount: 0 };
    }

    try {
      const message = {
        notification: {
          title: notification.title,
          body: notification.body,
          ...(notification.imageUrl && { imageUrl: notification.imageUrl }),
        },
        data: {
          ...normalizeFcmData(data),
          click_action: 'FLUTTER_NOTIFICATION_CLICK',
        },
        android: {
          priority: 'high',
          notification: {
            channelId: 'veepee_default',
            priority: 'high',
            defaultSound: true,
          },
        },
        apns: {
          payload: {
            aps: {
              sound: 'default',
              badge: 1,
            },
          },
        },
      };

      // Firebase takes at most 500 tokens per call.
      let successCount = 0;
      let failureCount = 0;
      let batchErrors = 0;
      const deadTokens = [];
      const badGuestTokens = [];
      for (let start = 0; start < fcmTokens.length; start += FCM_BATCH_SIZE) {
        const batch = fcmTokens.slice(start, start + FCM_BATCH_SIZE);
        let result;
        try {
          result = await messaging.sendEachForMulticast({ tokens: batch, ...message });
        } catch (error) {
          // One batch failing (network, quota) doesn't stop the others; its
          // phones count as failed.
          console.error('FCM batch failed:', error.message);
          failureCount += batch.length;
          batchErrors += 1;
          continue;
        }
        successCount += result.successCount;
        failureCount += result.failureCount;
        result.responses.forEach((resp, idx) => {
          // Only tokens Firebase says are gone; a temporary error keeps them.
          // "Invalid argument" can also mean the message itself was refused:
          // only trusted when others in the batch went through.
          if (!resp.success && DEAD_TOKEN_CODES.has(resp.error?.code)) deadTokens.push(batch[idx]);
          else if (!resp.success && result.successCount > 0 && BAD_GUEST_TOKEN_CODES.has(resp.error?.code)) badGuestTokens.push(batch[idx]);
        });
      }

      console.log(`Notifications sent: ${successCount} success, ${failureCount} failure`);
      if (deadTokens.length > 0) await this.removeInvalidTokens(deadTokens);
      if (badGuestTokens.length > 0) await this.removeBadGuestTokens(badGuestTokens);

      const response = { successCount, failureCount, batchErrors };
      return response;
    } catch (error) {
      console.error('Error sending multicast notification:', error);
      throw error;
    }
  }

  /**
   * A different message for each phone ([{ token, notification, data }]),
   * e.g. with each person's name or in their language. Sent with FCM
   * sendEach, at most 500 per call; dead tokens are switched off.
   * Returns null when Firebase is not set up.
   */
  async sendEachToDevices(messages) {
    const messaging = this.getMessagingInstance();
    if (!messaging) {
      console.warn('FCM not configured, skipping notification');
      return null;
    }
    if (!messages || messages.length === 0) return { successCount: 0, failureCount: 0 };

    const full = messages.map(({ token, notification, data }) => ({
      token,
      notification: {
        title: notification.title,
        body: notification.body,
        ...(notification.imageUrl && { imageUrl: notification.imageUrl }),
      },
      data: {
        ...normalizeFcmData(data),
        click_action: 'FLUTTER_NOTIFICATION_CLICK',
      },
      android: {
        priority: 'high',
        notification: {
          channelId: 'veepee_default',
          priority: 'high',
          defaultSound: true,
        },
      },
      apns: {
        payload: {
          aps: {
            sound: 'default',
            badge: 1,
          },
        },
      },
    }));

    let successCount = 0;
    let failureCount = 0;
    let batchErrors = 0;
    const deadTokens = [];
    const badGuestTokens = [];
    for (let start = 0; start < full.length; start += FCM_BATCH_SIZE) {
      const batch = full.slice(start, start + FCM_BATCH_SIZE);
      let result;
      try {
        result = await messaging.sendEach(batch);
      } catch (error) {
        console.error('FCM batch failed:', error.message);
        failureCount += batch.length;
        batchErrors += 1;
        continue;
      }
      successCount += result.successCount;
      failureCount += result.failureCount;
      result.responses.forEach((resp, idx) => {
        if (!resp.success && DEAD_TOKEN_CODES.has(resp.error?.code)) deadTokens.push(batch[idx].token);
        // (see sendToMultipleDevices: only when others in the batch went through)
        else if (!resp.success && result.successCount > 0 && BAD_GUEST_TOKEN_CODES.has(resp.error?.code)) badGuestTokens.push(batch[idx].token);
      });
    }
    console.log(`Personal notifications sent: ${successCount} success, ${failureCount} failure`);
    if (deadTokens.length > 0) await this.removeInvalidTokens(deadTokens);
    if (badGuestTokens.length > 0) await this.removeBadGuestTokens(badGuestTokens);
    return { successCount, failureCount, batchErrors };
  }

  async sendToUser(userId, notification, data = {}) {
    try {
      // Store notification in DB
      try {
        await Notification.create({
          userId,
          title: notification.title,
          body: notification.body,
          type: data.type || 'general',
          data,
        });
      } catch (dbErr) {
        console.error('Error storing notification:', dbErr);
      }

      const tokens = await DeviceToken.find({ userId, isActive: true }).select('fcmToken');
      if (!tokens || tokens.length === 0) {
        console.log(`No FCM tokens found for user ${userId}`);
        return null;
      }

      const fcmTokens = tokens.map(t => t.fcmToken);
      return await this.sendToMultipleDevices(fcmTokens, notification, data);
    } catch (error) {
      console.error('Error sending notification to user:', error);
      throw error;
    }
  }

  // Renders a template in the recipient's language, then sends and stores it.
  async sendLocalizedToUser(userId, templateKey, params = {}, data = {}) {
    const user = await User.findById(userId).select('preferredLanguage').lean();
    const language = normalizeLanguage(user?.preferredLanguage);
    return this.sendToUser(userId, renderTemplate(templateKey, language, params), data);
  }

  async sendToTopic(topic, notification, data = {}) {
    const messaging = this.getMessagingInstance();
    if (!messaging) {
      console.warn('FCM not configured, skipping notification');
      return null;
    }

    try {
      const message = {
        topic,
        notification: {
          title: notification.title,
          body: notification.body,
          ...(notification.imageUrl && { imageUrl: notification.imageUrl }),
        },
        data: {
          ...normalizeFcmData(data),
          click_action: 'FLUTTER_NOTIFICATION_CLICK',
        },
      };

      const response = await messaging.send(message);
      console.log('Topic notification sent:', response);
      return response;
    } catch (error) {
      console.error('Error sending topic notification:', error);
      throw error;
    }
  }

  async subscribeToTopic(fcmTokens, topic) {
    const messaging = this.getMessagingInstance();
    if (!messaging) return null;

    try {
      const response = await messaging.subscribeToTopic(fcmTokens, topic);
      console.log(`Subscribed ${response.successCount} tokens to topic ${topic}`);
      return response;
    } catch (error) {
      console.error('Error subscribing to topic:', error);
      throw error;
    }
  }

  async unsubscribeFromTopic(fcmTokens, topic) {
    const messaging = this.getMessagingInstance();
    if (!messaging) return null;

    try {
      const response = await messaging.unsubscribeFromTopic(fcmTokens, topic);
      console.log(`Unsubscribed ${response.successCount} tokens from topic ${topic}`);
      return response;
    } catch (error) {
      console.error('Error unsubscribing from topic:', error);
      throw error;
    }
  }

  async removeInvalidToken(token) {
    try {
      await DeviceToken.updateMany(
        { fcmToken: token },
        { $set: { isActive: false } }
      );
    } catch (error) {
      console.error('Error removing invalid token:', error);
    }
  }

  async removeBadGuestTokens(tokens) {
    try {
      await GuestDevice.deleteMany({ fcmToken: { $in: tokens } });
    } catch (error) {
      console.error('Error removing bad not-signed-in tokens:', error);
    }
  }

  async removeInvalidTokens(tokens) {
    try {
      await DeviceToken.updateMany(
        { fcmToken: { $in: tokens } },
        { $set: { isActive: false } }
      );
      // An uninstalled phone also leaves the not-signed-in list.
      await GuestDevice.deleteMany({ fcmToken: { $in: tokens } });
    } catch (error) {
      console.error('Error removing invalid tokens:', error);
    }
  }

  // Pre-built notification templates
  async sendOrderStatusUpdate(userId, orderId, status) {
    const templateByStatus = {
      confirmed: 'orderConfirmed',
      shipped: 'orderShipped',
      delivered: 'orderDelivered',
      cancelled: 'orderCancelled',
    };

    return this.sendLocalizedToUser(
      userId,
      templateByStatus[status] || 'orderUpdated',
      { status },
      { type: 'order_update', orderId: orderId.toString(), status }
    );
  }

  async sendPriceChange(userId, priceChange) {
    const {
      productId,
      productName,
      previousRetailPrice,
      retailPrice,
      previousWholesalePrice,
      wholesalePrice,
    } = priceChange;
    const customerPriceChanged = Number(previousRetailPrice) !== Number(retailPrice);

    return this.sendLocalizedToUser(
      userId,
      customerPriceChanged ? 'priceChanged' : 'priceChangedGeneric',
      { productName, retailPrice },
      {
        type: 'price_change',
        productId: productId.toString(),
        previousRetailPrice,
        retailPrice,
        previousWholesalePrice,
        wholesalePrice,
      }
    );
  }

  async notifyCartOwnersOfPriceChange(priceChange) {
    const userIds = await Cart.distinct('userId', {
      'items.productId': priceChange.productId,
    });
    if (userIds.length === 0) return { recipients: 0, failed: 0 };

    const results = await Promise.allSettled(
      userIds.map((userId) => this.sendPriceChange(userId, priceChange))
    );
    const failed = results.filter((result) => result.status === 'rejected').length;
    if (failed > 0) {
      console.error(`Failed to send ${failed} price-change notifications for product ${priceChange.productId}`);
    }
    return { recipients: userIds.length, failed };
  }

  // Tells everyone holding this product in their cart that its price will
  // change, each in their own language and with the price they would pay.
  // `template` is 'priceChangeScheduled' or 'priceChangeReminder'.
  async notifyCartOwnersOfScheduledPriceChange(change, template = 'priceChangeScheduled') {
    const carts = await Cart.find({ 'items.productId': change.productId }).select('userId').lean();
    if (carts.length === 0) return { recipients: 0, failed: 0 };

    const users = await User.find({ _id: { $in: carts.map((c) => c.userId) }, isActive: true })
      .select('role')
      .lean();
    const effectiveDate = new Intl.DateTimeFormat('en-IN', {
      day: 'numeric',
      month: 'short',
      timeZone: change.timeZone,
    }).format(new Date(change.effectiveAt));

    const results = await Promise.allSettled(users.map((user) => {
      const wholesaler = user.role === 'wholesaler';
      const newPrice = wholesaler ? change.newWholesalePrice : change.newRetailPrice;
      // Nothing to say to someone whose price is not changing.
      if (newPrice == null) return Promise.resolve();
      return this.sendLocalizedToUser(
        user._id,
        template,
        { productName: change.productName, newPrice, effectiveDate },
        {
          type: 'price_change_scheduled',
          productId: String(change.productId),
          effectiveAt: new Date(change.effectiveAt).toISOString(),
        }
      );
    }));
    const failed = results.filter((r) => r.status === 'rejected').length;
    return { recipients: users.length, failed };
  }

  async sendNegotiationUpdate(userId, negotiationId, message) {
    return this.sendLocalizedToUser(
      userId,
      'negotiationUpdate',
      { message },
      { type: 'negotiation_update', negotiationId: negotiationId.toString() }
    );
  }

  async sendNewProductAlert(productName, productId) {
    return this.sendToTopic('new_products', {
      title: 'New Product Available!',
      body: `Check out ${productName} - now available on OXON by Veepee`,
    }, {
      type: 'new_product',
      productId: productId.toString(),
    });
  }

  async sendPromotionalNotification(title, body, imageUrl = null) {
    return this.sendToTopic('promotions', {
      title,
      body,
      imageUrl,
    }, {
      type: 'promotion',
    });
  }

  async sendPaymentVerified(userId, orderId, orderNumber) {
    return this.sendLocalizedToUser(
      userId,
      'paymentVerified',
      { orderNumber },
      { type: 'payment_verified', orderId: orderId.toString() }
    );
  }

  async sendPaymentRejected(userId, orderId, orderNumber, reason) {
    return this.sendLocalizedToUser(
      userId,
      reason ? 'paymentRejectedWithReason' : 'paymentRejected',
      { orderNumber, reason },
      { type: 'payment_rejected', orderId: orderId.toString() }
    );
  }
}

module.exports = new NotificationService();
