const { getMessaging } = require('../config/firebase');
const { User } = require('../models');

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
          ...data,
          click_action: 'FLUTTER_NOTIFICATION_CLICK',
        },
        android: {
          priority: 'high',
          notification: {
            channelId: 'agrimart_default',
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
          ...data,
          click_action: 'FLUTTER_NOTIFICATION_CLICK',
        },
        android: {
          priority: 'high',
          notification: {
            channelId: 'agrimart_default',
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

      const response = await messaging.sendEachForMulticast({
        tokens: fcmTokens,
        ...message,
      });

      console.log(`Notifications sent: ${response.successCount} success, ${response.failureCount} failure`);

      // Handle failed tokens
      if (response.failureCount > 0) {
        const failedTokens = [];
        response.responses.forEach((resp, idx) => {
          if (!resp.success) {
            failedTokens.push(fcmTokens[idx]);
          }
        });
        // Remove invalid tokens
        await this.removeInvalidTokens(failedTokens);
      }

      return response;
    } catch (error) {
      console.error('Error sending multicast notification:', error);
      throw error;
    }
  }

  async sendToUser(userId, notification, data = {}) {
    try {
      const user = await User.findById(userId).select('fcmTokens');
      if (!user || !user.fcmTokens || user.fcmTokens.length === 0) {
        console.log(`No FCM tokens found for user ${userId}`);
        return null;
      }

      return await this.sendToMultipleDevices(user.fcmTokens, notification, data);
    } catch (error) {
      console.error('Error sending notification to user:', error);
      throw error;
    }
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
          ...data,
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
      await User.updateMany(
        { fcmTokens: token },
        { $pull: { fcmTokens: token } }
      );
    } catch (error) {
      console.error('Error removing invalid token:', error);
    }
  }

  async removeInvalidTokens(tokens) {
    try {
      await User.updateMany(
        { fcmTokens: { $in: tokens } },
        { $pull: { fcmTokens: { $in: tokens } } }
      );
    } catch (error) {
      console.error('Error removing invalid tokens:', error);
    }
  }

  // Pre-built notification templates
  async sendOrderStatusUpdate(userId, orderId, status) {
    const statusMessages = {
      confirmed: { title: 'Order Confirmed!', body: 'Your order has been confirmed and is being processed.' },
      shipped: { title: 'Order Shipped!', body: 'Your order is on its way!' },
      delivered: { title: 'Order Delivered!', body: 'Your order has been delivered. Enjoy!' },
      cancelled: { title: 'Order Cancelled', body: 'Your order has been cancelled.' },
    };

    const notification = statusMessages[status] || { 
      title: 'Order Update', 
      body: `Your order status has been updated to ${status}` 
    };

    return this.sendToUser(userId, notification, { 
      type: 'order_update', 
      orderId: orderId.toString(),
      status 
    });
  }

  async sendNegotiationUpdate(userId, negotiationId, message) {
    return this.sendToUser(userId, {
      title: 'Negotiation Update',
      body: message,
    }, {
      type: 'negotiation_update',
      negotiationId: negotiationId.toString(),
    });
  }

  async sendNewProductAlert(productName, productId) {
    return this.sendToTopic('new_products', {
      title: 'New Product Available!',
      body: `Check out ${productName} - now available on AgriMart`,
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
}

module.exports = new NotificationService();
