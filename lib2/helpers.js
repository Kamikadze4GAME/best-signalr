const BASE64_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ+/'.split('');

exports.to64 = function to64(_) {
  let res = [];
  while(true) {
    res.push(BASE64_ALPHABET[_ & 0x3F]);
    _ = _ >>> 6;
    if(!_) break;
  }
  return res.reverse().join('');
};
