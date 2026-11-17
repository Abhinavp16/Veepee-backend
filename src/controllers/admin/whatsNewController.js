const { User } = require('../../models');

// The admin panel's "What's new" highlights clear once a staff member has
// seen a feature. Seen ids are kept on their account so they clear on every
// device. Only the newest MAX_SEEN are kept; features stop counting as new
// after 30 days anyway, so older ids are never needed.
const MAX_SEEN = 200;

exports.getSeen = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id).select('seenFeatures').lean();
    res.json({ success: true, data: { ids: user?.seenFeatures || [] } });
  } catch (error) {
    next(error);
  }
};

exports.markSeen = async (req, res, next) => {
  try {
    const { ids } = req.body;
    let user = await User.findByIdAndUpdate(
      req.user._id,
      { $addToSet: { seenFeatures: { $each: ids } } },
      { new: true, projection: { seenFeatures: 1 } }
    ).lean();
    if ((user?.seenFeatures?.length || 0) > MAX_SEEN) {
      user = await User.findByIdAndUpdate(
        req.user._id,
        { $push: { seenFeatures: { $each: [], $slice: -MAX_SEEN } } },
        { new: true, projection: { seenFeatures: 1 } }
      ).lean();
    }
    res.json({ success: true, data: { ids: user?.seenFeatures || [] } });
  } catch (error) {
    next(error);
  }
};
