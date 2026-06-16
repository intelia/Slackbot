class SystemProducts {
  static apiUrl = process.env.ZUPA_PRODUCTS_API;
  static token = process.env.ZUPA_PRODUCTS_TOKEN;
  static async makeRequest({ endpoint, method = "GET", body = "" }) {
    try {
      const url = `${this.apiUrl}/${endpoint}`;
      const res = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.token}`,
        },
        body: body || null,
      });

      const data = await res.json();
      return data;
    } catch (error) {
      console.log("Error in makeRequest", error.message);
      return;
    }
  }

  static async fetchProducts() {
    try {
      const endpoint =
        "customer-requests/stores/8a7a28dc-b54d-4841-b949-efe60dbae709/products";
      const res = await this.makeRequest({ endpoint });
      if (!res) throw new Error("No response from makeRequest");
      const minifiedAllSystemProducts = res?.data?.map((sysp) => {
        const result = [];
        sysp.products.forEach((prod) => {
          result.push({
            name: prod.name,
            sizes: Object.keys(prod.sizes).map((s) => {
              if (prod.sizes[s].length !== 1) {
                return null;
              }
              return {
                name: s?.trim(),
                id: prod.sizes[s][0].id,
                price: prod.sizes[s][0].unitPrice,
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
    /**
     * sample payload
     * 
    {
      "customer": {
        "name": "Adebayo Johnson",
        "phoneNumber": "+2348012345678"
      },
      "order": {
        "amount": 15500,
        "specialNote": "Extra spicy please, no onions",
        "items": [
          {
            "productId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
            "quantity": 2,
            "price": 5000
          },
          {
            "productId": "f9e8d7c6-b5a4-3210-fedc-ba9876543210",
            "quantity": 1,
            "price": 5500
          }
        ]
      },
      "address": {
        "deliveryAddress": "14 Admiralty Way, Lekki Phase 1, Lagos",
        "isPickup": false,
        "cityId": "6d62e719-ebd0-4c0e-bb33-0f642b8a046b"
        "pickupStore": lekki | opebi
      }
    }
     */
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
        };
      });
    } catch (error) {
      console.log("Error fetching delivery cities:", error.message);
      return [];
    }
  }
}

module.exports = SystemProducts;
