class SystemProducts {
  static apiUrl = process.env.ZUPA_PRODUCTS_API;
  static token = process.env.ZUPA_PRODUCTS_TOKEN;
  static async makeRequest({
    endpoint,
    method = "GET",
    body = "",
    query = {},
  }) {
    try {
      const urlQuery = new URLSearchParams(query);
      const url = `${this.apiUrl}/${endpoint}?${urlQuery.toString()}`;
      console.log("🚀 ~ SystemProducts ~ makeRequest ~ url:", url);
      const res = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.token}`,
        },
        body: body || null,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.detail || err?.message || `Request failed (HTTP ${res.status})`);
      }

      const data = await res.json();
      return data;
    } catch (error) {
      console.log("Error in makeRequest", error.message);
      throw error;
    }
  }

  static async fetchProducts() {
    try {
      const endpoint =
        "customer-requests/stores/8a7a28dc-b54d-4841-b949-efe60dbae709/products";
      const res = await this.makeRequest({
        endpoint,
        query: { includeSpecial: true },
      });
      if (!res) throw new Error("No response from makeRequest");
      const minifiedAllSystemProducts = res?.data?.map((sysp) => {
        const category = (sysp.name || "").trim() || "Other";
        const result = [];
        sysp.products.forEach((prod) => {
          result.push({
            name: prod.name,
            category,
            sizes: Object.keys(prod.sizes).map((s) => {
              const skus = prod.sizes[s];
              if (!skus || skus.length === 0) return null;
              return {
                name: s?.trim(),
                id: skus[0].id,
                price: skus[0].unitPrice,
              };
            }),
          });
        });
        return result;
      });

      return minifiedAllSystemProducts.flat();
    } catch (error) {
      console.log(error.message);
    }
  }

  static async createOrder(payload) {
    try {
      const endpoint = "customer-requests/stores/slack-bot/order/new";
      const res = await this.makeRequest({
        endpoint,
        method: "POST",
        body: JSON.stringify(payload),
      });
      return res;
    } catch (error) {
      console.log("Error creating order:", error.message);
      return { status: "error", message: error.message };
    }
  }

  static async modifyOrder(payload) {
    try {
      const endpoint = "customer-requests/stores/slack-bot/order/modify";
      const res = await this.makeRequest({
        endpoint,
        method: "PATCH",
        body: JSON.stringify(payload),
      });
      return res;
    } catch (error) {
      console.log("Error modifying order:", error.message);
      return { status: "error", message: error.message };
    }
  }

  static async getDeliveryCities() {
    try {
      const endpoint = "auth/stores/8a7a28dc-b54d-4841-b949-efe60dbae709";
      const res = await this.makeRequest({ endpoint });
      if (!res) throw new Error("No response from makeRequest");
      return res?.delivery_types?.map((city) => {
        return {
          name: city.name,
          id: city.id,
          price: city.price,
          closestStore: city.closestStore,
        };
      });
    } catch (error) {
      console.log("Error fetching delivery cities:", error.message);
      return [];
    }
  }
}

module.exports = SystemProducts;
