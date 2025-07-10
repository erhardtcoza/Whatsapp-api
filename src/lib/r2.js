// r2.js - Utility functions for Cloudflare R2 interactions

export const R2 = {
  async upload(env, key, data, contentType = 'application/octet-stream') {
    await env.R2_BUCKET.put(key, data, {
      httpMetadata: {
        contentType,
      },
    });
    return key;
  },

  async download(env, key) {
    const obj = await env.R2_BUCKET.get(key);
    if (!obj) return null;
    const data = await obj.arrayBuffer();
    return data;
  },

  async getPublicUrl(key) {
    return `https://w-image.vinetdns.co.za/${key}`;
  },

  async delete(env, key) {
    await env.R2_BUCKET.delete(key);
  },

  async uploadMediaFromWhatsApp(env, mediaId, folder, filename, token) {
    const mediaApi = `https://graph.facebook.com/v22.0/${mediaId}`;
    
    const mediaMeta = await fetch(mediaApi, {
      headers: { Authorization: `Bearer ${token}` }
    });

    if (!mediaMeta.ok) {
      throw new Error(`Failed to fetch media metadata: ${mediaMeta.status}`);
    }

    const mediaData = await mediaMeta.json();
    const directUrl = mediaData.url;

    const mediaRes = await fetch(directUrl, {
      headers: { Authorization: `Bearer ${token}` }
    });

    if (!mediaRes.ok) {
      throw new Error(`Failed to fetch media content: ${mediaRes.status}`);
    }

    const buf = await mediaRes.arrayBuffer();
    const key = `${folder}/${filename}`;

    await this.upload(env, key, buf, mediaRes.headers.get('Content-Type'));

    return this.getPublicUrl(key);
  },
};
