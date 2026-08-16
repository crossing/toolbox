package cli

import (
	"github.com/crossing/toolbox/tools/freeagent/internal/freeagent"

	"github.com/spf13/cobra"
)

var expensesCmd = &cobra.Command{
	Use:   "expenses",
	Short: "Manage out-of-pocket expenses",
	Long:  "Commands to list and create out-of-pocket expenses (money a user paid personally on behalf of the company).",
}

var expensesFromDate string

var expensesListCmd = &cobra.Command{
	Use:   "list",
	Short: "List out-of-pocket expenses",
	RunE: func(cmd *cobra.Command, args []string) error {
		expenses, err := apiClient.ListExpenses(expensesFromDate)
		if err != nil {
			return err
		}

		return formatOutput(expenses)
	},
}

var (
	expenseUser        string
	expenseCategory    string
	expenseDatedOn     string
	expenseGrossValue  string
	expenseDescription string
	expenseSalesTax    string
	expenseManualTax   string
	expenseFile        string
	expenseCurrency    string
	expenseECStatus    string
)

var expensesCreateCmd = &cobra.Command{
	Use:   "create",
	Short: "Create an out-of-pocket expense",
	Long:  "Record an expense paid personally by a user. Gross value must be negative for money paid out. Optionally attach a receipt in the same call via --file.",
	RunE: func(cmd *cobra.Command, args []string) error {
		expense := freeagent.Expense{
			User:                 expenseUser,
			Category:             expenseCategory,
			DatedOn:              expenseDatedOn,
			GrossValue:           expenseGrossValue,
			Description:          expenseDescription,
			SalesTaxRate:         expenseSalesTax,
			ManualSalesTaxAmount: expenseManualTax,
			Currency:             expenseCurrency,
			ECStatus:             expenseECStatus,
		}

		if expenseFile != "" {
			attachment, err := freeagent.CreateAttachmentFromFile(expenseFile)
			if err != nil {
				return err
			}
			expense.Attachment = attachment
		}

		newExpense, err := apiClient.CreateExpense(expense)
		if err != nil {
			return err
		}

		return formatOutput(newExpense)
	},
}

func init() {
	rootCmd.AddCommand(expensesCmd)
	expensesCmd.AddCommand(expensesListCmd)
	expensesCmd.AddCommand(expensesCreateCmd)

	expensesListCmd.Flags().StringVar(&expensesFromDate, "from", "", "Only expenses dated on or after this date (YYYY-MM-DD)")

	expensesCreateCmd.Flags().StringVar(&expenseUser, "user", "", "User URI who paid the expense")
	expensesCreateCmd.Flags().StringVar(&expenseCategory, "category", "", "Category URI")
	expensesCreateCmd.Flags().StringVar(&expenseDatedOn, "date", "", "Expense date (YYYY-MM-DD)")
	expensesCreateCmd.Flags().StringVar(&expenseGrossValue, "value", "", "Gross value (negative for money paid out)")
	expensesCreateCmd.Flags().StringVar(&expenseDescription, "description", "", "Description")
	expensesCreateCmd.Flags().StringVar(&expenseSalesTax, "sales-tax-rate", "", "Sales tax (VAT) rate percentage, e.g. 20")
	expensesCreateCmd.Flags().StringVar(&expenseManualTax, "manual-sales-tax-amount", "", "Explicit sales tax amount when a rate does not apply cleanly")
	expensesCreateCmd.Flags().StringVar(&expenseFile, "file", "", "Path to a receipt/invoice to attach")
	expensesCreateCmd.Flags().StringVar(&expenseCurrency, "currency", "", "Currency code when not the company's native currency, e.g. USD")
	expensesCreateCmd.Flags().StringVar(&expenseECStatus, "ec-status", "", "EC/VAT status: 'UK/Non-EC' (default) or 'Reverse Charge' for services from overseas suppliers")

	_ = expensesCreateCmd.MarkFlagRequired("user")
	_ = expensesCreateCmd.MarkFlagRequired("category")
	_ = expensesCreateCmd.MarkFlagRequired("date")
	_ = expensesCreateCmd.MarkFlagRequired("value")
}
