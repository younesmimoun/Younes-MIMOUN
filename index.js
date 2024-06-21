const path = require('path');
const express = require('express');
const oracledb = require('oracledb');

const app = express();
oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;

let connection;

async function connectToDatabase() {
    try {
        connection = await oracledb.getConnection({
            user: "myadmin",
            password: "password",
            connectionString: "0.0.0.0:1521/xepdb1",
        });
        console.log("Successfully connected to Oracle Database");
    } catch (err) {
        console.error("Error connecting to Oracle Database:", err);
    }
}

async function setupDatabase() {
    try {
        console.log("Dropping old tables...");
        // Supprimer les anciennes tables (uniquement pour le développement)
        await connection.execute(`
            BEGIN
                EXECUTE IMMEDIATE 'DROP TABLE transactions CASCADE CONSTRAINTS';
                EXECUTE IMMEDIATE 'DROP TABLE accounts CASCADE CONSTRAINTS';
                EXECUTE IMMEDIATE 'DROP TABLE users CASCADE CONSTRAINTS';
                EXCEPTION WHEN OTHERS THEN IF SQLCODE <> -942 THEN RAISE; END IF;
            END;
        `);

        console.log("Creating users table...");
        // Créer les nouvelles tables
        await connection.execute(`
            CREATE TABLE users (
                id NUMBER GENERATED ALWAYS AS IDENTITY,
                name VARCHAR2(256),
                email VARCHAR2(512),
                creation_ts TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                accounts NUMBER,
                PRIMARY KEY (id)
            )
        `);

        console.log("Creating accounts table...");
        await connection.execute(`
            CREATE TABLE accounts (
                id NUMBER GENERATED ALWAYS AS IDENTITY,
                name VARCHAR2(256),
                amount NUMBER,
                transactions NUMBER,
                user_id NUMBER,
                CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id),
                creation_ts TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (id)
            )
        `);

        console.log("Creating transactions table...");
        await connection.execute(`
            CREATE TABLE transactions (
                id NUMBER GENERATED ALWAYS AS IDENTITY,
                name VARCHAR2(256),
                amount NUMBER,
                type NUMBER,
                account_id NUMBER,
                CONSTRAINT fk_account FOREIGN KEY (account_id) REFERENCES accounts(id),
                creation_ts TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (id)
            )
        `);

        console.log("Creating index on transactions table...");
        // Ajouter un index sur transactions pour optimiser les requêtes
        await connection.execute(`
            CREATE INDEX idx_transactions_account_creation
            ON transactions (account_id, creation_ts)
        `);

        console.log("Creating stored procedures...");
        // Ajouter les procédures stockées
        await connection.execute(`
            CREATE OR REPLACE PROCEDURE insert_user (
                p_user_name IN users.name%TYPE,
                p_user_email IN users.email%TYPE,
                p_user_id OUT users.id%TYPE
            ) AS
            BEGIN
                INSERT INTO users (name, email)
                VALUES (p_user_name, p_user_email)
                RETURNING id INTO p_user_id;
            END;
        `);

        await connection.execute(`
            CREATE OR REPLACE PROCEDURE create_account (
                p_account_name IN accounts.name%TYPE,
                p_amount IN accounts.amount%TYPE,
                p_user_id IN accounts.user_id%TYPE,
                p_account_id OUT accounts.id%TYPE
            ) AS
            BEGIN
                INSERT INTO accounts (name, amount, user_id, transactions)
                VALUES (p_account_name, p_amount, p_user_id, 0)
                RETURNING id INTO p_account_id;

                UPDATE users SET accounts = accounts + 1 WHERE id = p_user_id;
            END;
        `);

        await connection.execute(`
            CREATE OR REPLACE PROCEDURE create_transaction (
                p_transaction_name IN transactions.name%TYPE,
                p_amount IN transactions.amount%TYPE,
                p_type IN transactions.type%TYPE,
                p_account_id IN transactions.account_id%TYPE,
                p_transaction_id OUT transactions.id%TYPE
            ) AS
            BEGIN
                INSERT INTO transactions (name, amount, type, account_id)
                VALUES (p_transaction_name, p_amount, p_type, p_account_id)
                RETURNING id INTO p_transaction_id;

                IF p_type = 1 THEN
                    UPDATE accounts SET amount = amount + p_amount WHERE id = p_account_id;
                ELSE
                    UPDATE accounts SET amount = amount - p_amount WHERE id = p_account_id;
                END IF;

                UPDATE accounts SET transactions = transactions + 1 WHERE id = p_account_id;
            END;
        `);

        await connection.execute(`
            CREATE OR REPLACE FUNCTION format_transaction_name (
                p_type IN NUMBER,
                p_name IN VARCHAR2
            ) RETURN VARCHAR2 IS
                v_formatted_name VARCHAR2(256);
            BEGIN
                v_formatted_name := 'T' || p_type || '-' || UPPER(p_name);
                RETURN v_formatted_name;
            END;
        `);

        // Ajouter la procédure pour les transactions avec budget
        await connection.execute(`
            CREATE OR REPLACE PROCEDURE get_transactions_within_budget (
                p_account_id IN transactions.account_id%TYPE,
                p_budget IN NUMBER,
                p_transactions OUT SYS_REFCURSOR
            ) AS
                v_total NUMBER := 0;
                v_id transactions.id%TYPE;
                v_name transactions.name%TYPE;
                v_amount transactions.amount%TYPE;
                v_type transactions.type%TYPE;
            BEGIN
                OPEN p_transactions FOR
                    SELECT id, name, amount, type
                    FROM transactions
                    WHERE account_id = p_account_id
                    ORDER BY creation_ts;

                LOOP
                    FETCH p_transactions INTO v_id, v_name, v_amount, v_type;
                    EXIT WHEN p_transactions%NOTFOUND OR v_total + v_amount > p_budget;

                    v_total := v_total + v_amount;
                END LOOP;
                CLOSE p_transactions;
            END;
        `);

        // Ajouter le trigger pour les transactions
        await connection.execute(`
            CREATE OR REPLACE TRIGGER transaction_trigger
            AFTER INSERT OR UPDATE OR DELETE ON transactions
            FOR EACH ROW
            BEGIN
                IF INSERTING THEN
                    IF :NEW.type = 1 THEN
                        UPDATE accounts SET amount = amount + :NEW.amount WHERE id = :NEW.account_id;
                    ELSE
                        UPDATE accounts SET amount = amount - :NEW.amount WHERE id = :NEW.account_id;
                    END IF;
                    UPDATE accounts SET transactions = transactions + 1 WHERE id = :NEW.account_id;
                ELSIF UPDATING THEN
                    IF :OLD.type = 1 THEN
                        UPDATE accounts SET amount = amount - :OLD.amount WHERE id = :OLD.account_id;
                    ELSE
                        UPDATE accounts SET amount = amount + :OLD.amount WHERE id = :OLD.account_id;
                    END IF;
                    IF :NEW.type = 1 THEN
                        UPDATE accounts SET amount = amount + :NEW.amount WHERE id = :NEW.account_id;
                    ELSE
                        UPDATE accounts SET amount = amount - :NEW.amount WHERE id = :NEW.account_id;
                    END IF;
                ELSIF DELETING THEN
                    IF :OLD.type = 1 THEN
                        UPDATE accounts SET amount = amount - :OLD.amount WHERE id = :OLD.account_id;
                    ELSE
                        UPDATE accounts SET amount = amount + :OLD.amount WHERE id = :OLD.account_id;
                    END IF;
                    UPDATE accounts SET transactions = transactions - 1 WHERE id = :OLD.account_id;
                END IF;
            END;
        `);

        // Créer une vue sécurisée pour les transactions
        await connection.execute(`
            CREATE OR REPLACE VIEW secure_transactions AS
            SELECT
                id,
                amount,
                creation_ts,
                account_id
            FROM transactions
        `);

        // Ajouter la procédure pour lire le fichier exporté
        await connection.execute(`
            CREATE OR REPLACE PROCEDURE read_export_file (
                p_filename IN VARCHAR2,
                p_content OUT CLOB
            ) AS
                l_file BFILE;
                l_clob CLOB;
            BEGIN
                -- Initialize the CLOB
                DBMS_LOB.CREATETEMPORARY(l_clob, TRUE);

                -- Open the BFILE
                l_file := BFILENAME('EXPORT_DIR', p_filename);
                DBMS_LOB.FILEOPEN(l_file, DBMS_LOB.FILE_READONLY);

                -- Load the BFILE into the CLOB
                DBMS_LOB.LOADFROMFILE(l_clob, l_file, DBMS_LOB.GETLENGTH(l_file));

                -- Close the BFILE
                DBMS_LOB.FILECLOSE(l_file);

                -- Set the OUT parameter
                p_content := l_clob;
            EXCEPTION
                WHEN OTHERS THEN
                    -- Close the BFILE if open
                    IF DBMS_LOB.FILEISOPEN(l_file) = 1 THEN
                        DBMS_LOB.FILECLOSE(l_file);
                    END IF;
                    RAISE;
            END;
        `);

        console.log("Inserting initial data...");
        // Insérer des données initiales
        const usersSql = `INSERT INTO users (name, email, accounts) VALUES (:1, :2, :3)`;
        const usersRows = [
            ["Valentin Montagne", "contact@vm-it-consulting.com", 0],
            ["Amélie Dal", "amelie.dal@gmail.com", 0],
        ];
        let usersResult = await connection.executeMany(usersSql, usersRows);
        console.log(usersResult.rowsAffected, "Users rows inserted");

        const accountsSql = `INSERT INTO accounts (name, amount, transactions, user_id) VALUES (:1, :2, :3, :4)`;
        const accountsRows = [["Compte courant", 2000, 0, 1]];
        let accountsResult = await connection.executeMany(accountsSql, accountsRows);
        console.log(accountsResult.rowsAffected, "Accounts rows inserted");

        await connection.commit(); // Valider les transactions
    } catch (err) {
        console.error("Error setting up the database:", err);
    }
}

// Définir EJS comme moteur de vue
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/', async (req, res) => {
    res.render('index');
});

app.get('/create-user', (req, res) => {
    res.render('create-user');
});

app.get('/create-account', (req, res) => {
    res.render('create-account');
});

app.get('/create-transaction', (req, res) => {
    res.render('create-transaction');
});


// Route pour récupérer la liste des utilisateurs
app.get('/users', async (req, res) => {
    const getUsersSQL = `SELECT * FROM users`;
    try {
        const result = await connection.execute(getUsersSQL);
        res.render('users', { users: result.rows });
    } catch (err) {
        console.error("Error fetching users:", err);
        res.status(500).send("Error fetching users");
    }
});

// Route pour créer un nouvel utilisateur
app.post("/users", async (req, res) => {
    const createUserSQL = `
        BEGIN
            insert_user(:name, :email, :user_id);
        END;
    `;
    try {
        const result = await connection.execute(createUserSQL, {
            name: req.body.name,
            email: req.body.email,
            user_id: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
        });
        console.log(result);
        if (result.outBinds && result.outBinds.user_id) {
            res.redirect(`/views/${result.outBinds.user_id}`);
        } else {
            res.sendStatus(500);
        }
    } catch (err) {
        console.error("Error creating user:", err);
        res.status(500).send("Error creating user");
    }
});

// Route pour afficher la page d'accueil d'un utilisateur
app.get("/views/:userId", async (req, res) => {
    const getCurrentUserSQL = `SELECT * FROM users WHERE id = :1`;
    const getAccountsSQL = `SELECT * FROM accounts WHERE user_id = :1`;
    try {
        const [currentUser, accounts] = await Promise.all([
            connection.execute(getCurrentUserSQL, [req.params.userId]),
            connection.execute(getAccountsSQL, [req.params.userId]),
        ]);
        console.log(currentUser, accounts);
        res.render("user-view", {
            currentUser: currentUser.rows[0],
            accounts: accounts.rows,
        });
    } catch (err) {
        console.error("Error fetching user data:", err);
        res.status(500).send("Error fetching user data");
    }
});

// Route pour récupérer la liste des comptes bancaires
app.get('/accounts', async (req, res) => {
    const getAccountsSQL = `SELECT * FROM accounts`;
    try {
        const result = await connection.execute(getAccountsSQL);
        res.render('accounts', { accounts: result.rows });
    } catch (err) {
        console.error("Error fetching accounts:", err);
        res.status(500).send("Error fetching accounts");
    }
});

// Route pour créer un nouveau compte bancaire
app.post("/accounts", async (req, res) => {
    const createAccountSQL = `
        BEGIN
            create_account(:name, :amount, :user_id, :account_id);
        END;
    `;
    try {
        const result = await connection.execute(createAccountSQL, {
            name: req.body.name,
            amount: req.body.amount,
            user_id: req.body.user_id,
            account_id: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
        });
        console.log(result);
        if (result.outBinds && result.outBinds.account_id) {
            res.redirect(`/views/${req.body.user_id}`);
        } else {
            res.sendStatus(500);
        }
    } catch (err) {
        console.error("Error creating account:", err);
        res.status(500).send("Error creating account");
    }
});

// Route pour récupérer la liste des transactions
app.get('/transactions', async (req, res) => {
    const getTransactionsSQL = `SELECT * FROM transactions`;
    try {
        const result = await connection.execute(getTransactionsSQL);
        res.render('transactions', { transactions: result.rows });
    } catch (err) {
        console.error("Error fetching transactions:", err);
        res.status(500).send("Error fetching transactions");
    }
});


// Route pour créer une nouvelle transaction
app.post("/transactions", async (req, res) => {
    const createTransactionSQL = `
        BEGIN
            create_transaction(:name, :amount, :type, :account_id, :transaction_id);
        END;
    `;
    try {
        const result = await connection.execute(createTransactionSQL, {
            name: req.body.name,
            amount: req.body.amount,
            type: req.body.type,
            account_id: req.body.account_id,
            transaction_id: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
        });
        console.log(result);
        if (result.outBinds && result.outBinds.transaction_id) {
            res.redirect(`/views/${req.body.user_id}`);
        } else {
            res.sendStatus(500);
        }
    } catch (err) {
        console.error("Error creating transaction:", err);
        res.status(500).send("Error creating transaction");
    }
});

// Route pour afficher les transactions d'un compte
app.get("/views/:userId/:accountId", async (req, res) => {
    const getCurrentAccountSQL = `SELECT * FROM accounts WHERE id = :1 AND user_id = :2`;
    const getTransactionsSQL = `SELECT id, format_transaction_name(type, name) AS name, amount, type FROM transactions WHERE account_id = :1`;
    try {
        const [currentAccount, transactions] = await Promise.all([
            connection.execute(getCurrentAccountSQL, [req.params.accountId, req.params.userId]),
            connection.execute(getTransactionsSQL, [req.params.accountId]),
        ]);
        console.log(currentAccount, transactions);
        res.render("account-view", {
            currentAccount: currentAccount.rows[0],
            transactions: transactions.rows,
        });
    } catch (err) {
        console.error("Error fetching account data:", err);
        res.status(500).send("Error fetching account data");
    }
});

// Route pour exporter les transactions d'un compte en CSV
app.post("/accounts/:accountId/exports", async (req, res) => {
    const exportSQL = `
        BEGIN
            myadmin.export_transactions_to_csv;
        END;
    `;
    try {
        await connection.execute(exportSQL);
        res.status(200).send("Transactions exported successfully");
    } catch (err) {
        console.error("Error exporting transactions:", err);
        res.status(500).send("Error exporting transactions: " + err.message);
    }
});

// Route pour récupérer le fichier CSV exporté
app.get("/accounts/:accountId/exports", async (req, res) => {
    const exportSQL = `
        BEGIN
            read_export_file('transactions.csv', :content);
        END;
    `;
    try {
        const result = await connection.execute(exportSQL, {
            content: { dir: oracledb.BIND_OUT, type: oracledb.CLOB },
        });
        const data = await result.outBinds.content.getData();
        res.json({ content: data });
    } catch (err) {
        console.error("Error fetching exported transactions:", err);
        res.status(500).send("Error fetching exported transactions");
    }
});

// Route pour récupérer les transactions jusqu'à ce que le budget soit dépassé
app.get("/accounts/:accountId/budgets/:amount", async (req, res) => {
    const getTransactionsWithinBudgetSQL = `
        BEGIN
            get_transactions_within_budget(:account_id, :budget, :transactions);
        END;
    `;
    try {
        const result = await connection.execute(getTransactionsWithinBudgetSQL, {
            account_id: req.params.accountId,
            budget: req.params.amount,
            transactions: { dir: oracledb.BIND_OUT, type: oracledb.CURSOR },
        });

        const cursor = result.outBinds.transactions;
        let transactions = [];
        let row;
        while ((row = await cursor.getRow())) {
            transactions.push(row);
        }
        await cursor.close();

        res.json(transactions);
    } catch (err) {
        console.error("Error fetching transactions within budget:", err);
        res.status(500).send("Error fetching transactions within budget");
    }
});

// Définir la fonction pour générer des transactions factices
async function generateFakeTransactions(accountId, numberOfTransactions) {
    const insertTransactionSQL = `
        BEGIN
            create_transaction(:name, :amount, :type, :account_id, :transaction_id);
        END;
    `;
    try {
        for (let i = 0; i < numberOfTransactions; i++) {
            const amount = Math.floor(Math.random() * 1000);
            const type = Math.random() > 0.5 ? 1 : 0;
            await connection.execute(insertTransactionSQL, {
                name: `Fake Transaction ${i + 1}`,
                amount: amount,
                type: type,
                account_id: accountId,
                transaction_id: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
            });
        }
        await connection.commit();
        console.log(`${numberOfTransactions} fake transactions inserted for account ${accountId}`);
    } catch (err) {
        console.error("Error generating fake transactions:", err);
    }
}

connectToDatabase().then(async () => {
    await setupDatabase();
    // Générer des transactions factices (exemple avec 10000 transactions)
    await generateFakeTransactions(1, 10000);
    // Démarrer le serveur
    app.listen(3000, () => {
        console.log('Server started on http://localhost:3000');
    });
});
