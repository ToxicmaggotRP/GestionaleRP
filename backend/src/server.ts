import "dotenv/config";

import express from "express";
import cors from "cors";

import {
  PrismaClient,
  MoneyType,
  TransactionType,
  InventoryMovementType
} from "@prisma/client";

import { z } from "zod";

const app = express();

const prisma = new PrismaClient();

const PORT = Number(process.env.PORT || 3000);

app.use(
  cors({
    origin: process.env.CORS_ORIGIN?.split(",") || "*"
  })
);

app.use(express.json());

/*
|--------------------------------------------------------------------------
| HEALTH
|--------------------------------------------------------------------------
*/

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "mafia-manager"
  });
});

/*
|--------------------------------------------------------------------------
| DASHBOARD
|--------------------------------------------------------------------------
*/

app.get("/api/dashboard", async (_req, res) => {
  try {
    const [
      cleanIncome,
      dirtyIncome,
      cleanExpense,
      dirtyExpense,
      products,
      contacts,
      sales
    ] = await Promise.all([
      prisma.transaction.aggregate({
        _sum: {
          amount: true
        },
        where: {
          type: "INCOME",
          moneyType: "CLEAN"
        }
      }),

      prisma.transaction.aggregate({
        _sum: {
          amount: true
        },
        where: {
          type: "INCOME",
          moneyType: "DIRTY"
        }
      }),

      prisma.transaction.aggregate({
        _sum: {
          amount: true
        },
        where: {
          type: "EXPENSE",
          moneyType: "CLEAN"
        }
      }),

      prisma.transaction.aggregate({
        _sum: {
          amount: true
        },
        where: {
          type: "EXPENSE",
          moneyType: "DIRTY"
        }
      }),

      prisma.product.findMany(),

      prisma.contact.count(),

      prisma.sale.count()
    ]);

    const clean =
      (cleanIncome._sum.amount || 0) -
      (cleanExpense._sum.amount || 0);

    const dirty =
      (dirtyIncome._sum.amount || 0) -
      (dirtyExpense._sum.amount || 0);

    const stockValue = products.reduce(
      (total, product) =>
        total +
        product.quantity * product.purchasePrice,
      0
    );

    const lowStock = products.filter(
      product =>
        product.quantity <= product.minimumQuantity
    );

    res.json({
      clean,
      dirty,
      total: clean + dirty,
      contacts,
      sales,
      stockValue,
      lowStock
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Errore caricamento dashboard"
    });
  }
});

/*
|--------------------------------------------------------------------------
| CONTACTS
|--------------------------------------------------------------------------
*/

app.get("/api/contacts", async (_req, res) => {
  const contacts = await prisma.contact.findMany({
    orderBy: {
      createdAt: "desc"
    }
  });

  res.json(contacts);
});

app.post("/api/contacts", async (req, res) => {
  try {

    const schema = z.object({
      firstName: z.string().min(1),
      lastName: z.string().optional(),
      alias: z.string().optional(),
      phone: z.string().optional(),
      type: z.string().default("Cliente"),
      reliability: z.number().int().min(1).max(5).default(3),
      notes: z.string().optional()
    });

    const data = schema.parse(req.body);

    const contact =
      await prisma.contact.create({
        data
      });

    await prisma.auditLog.create({
      data: {
        action: "CREATE",
        entity: "Contact",
        entityId: contact.id
      }
    });

    res.status(201).json(contact);

  } catch (error) {

    console.error(error);

    res.status(400).json({
      error: "Dati contatto non validi"
    });
  }
});

/*
|--------------------------------------------------------------------------
| PRODUCTS
|--------------------------------------------------------------------------
*/

app.get("/api/products", async (_req, res) => {

  const products =
    await prisma.product.findMany({
      orderBy: {
        name: "asc"
      }
    });

  res.json(products);
});

app.post("/api/products", async (req, res) => {

  try {

    const schema = z.object({
      name: z.string().min(1),
      category: z.string().optional(),
      quantity: z.number().int().nonnegative(),
      minimumQuantity: z.number().int().nonnegative(),
      purchasePrice: z.number().nonnegative(),
      salePrice: z.number().nonnegative()
    });

    const data = schema.parse(req.body);

    const product =
      await prisma.product.create({
        data
      });

    if (data.quantity > 0) {

      await prisma.inventoryMovement.create({
        data: {
          productId: product.id,
          type: InventoryMovementType.IN,
          quantity: data.quantity,
          reason: "Carico iniziale"
        }
      });

    }

    res.status(201).json(product);

  } catch (error) {

    console.error(error);

    res.status(400).json({
      error: "Prodotto non valido"
    });
  }
});

/*
|--------------------------------------------------------------------------
| TRANSACTIONS
|--------------------------------------------------------------------------
*/

app.get("/api/transactions", async (_req, res) => {

  const transactions =
    await prisma.transaction.findMany({
      orderBy: {
        createdAt: "desc"
      },
      take: 100
    });

  res.json(transactions);
});

app.post("/api/transactions", async (req, res) => {

  try {

    const schema = z.object({
      type: z.enum(["INCOME", "EXPENSE"]),
      moneyType: z.enum(["CLEAN", "DIRTY"]),
      amount: z.number().positive(),
      category: z.string().min(1),
      description: z.string().optional()
    });

    const data = schema.parse(req.body);

    const transaction =
      await prisma.transaction.create({
        data
      });

    await prisma.auditLog.create({
      data: {
        action: "CREATE",
        entity: "Transaction",
        entityId: transaction.id
      }
    });

    res.status(201).json(transaction);

  } catch (error) {

    console.error(error);

    res.status(400).json({
      error: "Movimento non valido"
    });
  }
});

/*
|--------------------------------------------------------------------------
| SALES
|--------------------------------------------------------------------------
*/

app.get("/api/sales", async (_req, res) => {

  const sales =
    await prisma.sale.findMany({
      include: {
        contact: true,
        items: {
          include: {
            product: true
          }
        }
      },
      orderBy: {
        createdAt: "desc"
      }
    });

  res.json(sales);
});

app.post("/api/sales", async (req, res) => {

  try {

    const schema = z.object({
      contactId: z.number().int().nullable().optional(),

      moneyType: z.enum([
        "CLEAN",
        "DIRTY"
      ]),

      notes: z.string().optional(),

      items: z.array(
        z.object({
          productId: z.number().int(),
          quantity: z.number().int().positive()
        })
      ).min(1)
    });

    const data = schema.parse(req.body);

    const sale =
      await prisma.$transaction(
        async tx => {

          const products =
            await Promise.all(
              data.items.map(
                item =>
                  tx.product.findUnique({
                    where: {
                      id: item.productId
                    }
                  })
              )
            );

          let total = 0;

          for (
            let i = 0;
            i < data.items.length;
            i++
          ) {

            const item = data.items[i];

            const product =
              products[i];

            if (!product) {
              throw new Error(
                "Prodotto non trovato"
              );
            }

            if (
              product.quantity <
              item.quantity
            ) {
              throw new Error(
                `Scorte insufficienti: ${product.name}`
              );
            }

            total +=
              product.salePrice *
              item.quantity;
          }

          const created =
            await tx.sale.create({

              data: {

                contactId:
                  data.contactId ?? null,

                total,

                moneyType:
                  data.moneyType as MoneyType,

                notes:
                  data.notes,

                items: {

                  create:
                    data.items.map(
                      (item, index) => {

                        const product =
                          products[index]!;

                        return {

                          productId:
                            item.productId,

                          quantity:
                            item.quantity,

                          unitPrice:
                            product.salePrice,

                          total:
                            product.salePrice *
                            item.quantity
                        };
                      }
                    )
                }
              },

              include: {
                items: true
              }
            });

          /*
           * Scarico magazzino
           */

          for (const item of data.items) {

            await tx.product.update({

              where: {
                id: item.productId
              },

              data: {
                quantity: {
                  decrement:
                    item.quantity
                }
              }
            });

            await tx.inventoryMovement.create({

              data: {

                productId:
                  item.productId,

                type:
                  InventoryMovementType.OUT,

                quantity:
                  item.quantity,

                reason:
                  `Vendita #${created.id}`
              }
            });
          }

          /*
           * Registrazione finanziaria
           */

          await tx.transaction.create({

            data: {

              type:
                TransactionType.INCOME,

              moneyType:
                data.moneyType as MoneyType,

              amount:
                total,

              category:
                "Vendita",

              description:
                `Vendita #${created.id}`
            }
          });

          /*
           * Audit
           */

          await tx.auditLog.create({

            data: {

              action:
                "CREATE",

              entity:
                "Sale",

              entityId:
                created.id,

              details:
                JSON.stringify(data)
            }
          });

          return created;
        }
      );

    res.status(201).json(sale);

  } catch (error) {

    console.error(error);

    res.status(400).json({

      error:
        error instanceof Error
          ? error.message
          : "Errore creazione vendita"
    });
  }
});

/*
|--------------------------------------------------------------------------
| SERVER
|--------------------------------------------------------------------------
*/

app.listen(PORT, "0.0.0.0", () => {

  console.log(
    `Mafia Manager API running on port ${PORT}`
  );

});
