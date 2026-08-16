package cli

import (
	"github.com/crossing/toolbox/tools/freeagent/internal/freeagent"

	"github.com/spf13/cobra"
)

var (
	expTransaction     string
	expBankAccount     string
	expDatedOn         string
	expGrossValue      string
	expCategory        string
	expDescription     string
	expPaidBill        string
	expTransferAccount string
	expSalesTaxRate    string
	expManualTax       string
	expCreateFile      string
)

// explanationsCreateCmd represents the create command
var explanationsCreateCmd = &cobra.Command{
	Use:   "create",
	Short: "Create a bank transaction explanation",
	Long: `Explain a bank transaction. Exactly one of these should describe the money:
  --category           a spending/income category URI
  --paid-bill          a bill URI this payment settles
  --transfer-account   the other bank account URI for transfers between own accounts
Optionally attach a receipt in the same call via --file.`,
	RunE: func(cmd *cobra.Command, args []string) error {
		explanation := freeagent.BankTransactionExplanation{
			BankTransaction:      expTransaction,
			BankAccount:          expBankAccount,
			DatedOn:              expDatedOn,
			GrossValue:           expGrossValue,
			Category:             expCategory,
			Description:          expDescription,
			PaidBill:             expPaidBill,
			TransferBankAccount:  expTransferAccount,
			SalesTaxRate:         expSalesTaxRate,
			ManualSalesTaxAmount: expManualTax,
		}

		if expCreateFile != "" {
			attachment, err := freeagent.CreateAttachmentFromFile(expCreateFile)
			if err != nil {
				return err
			}
			explanation.Attachment = attachment
		}

		newExplanation, err := apiClient.CreateBankTransactionExplanation(explanation)
		if err != nil {
			return err
		}

		return formatOutput(newExplanation)
	},
}

func init() {
	explanationsCmd.AddCommand(explanationsCreateCmd)

	explanationsCreateCmd.Flags().StringVar(&expTransaction, "transaction", "", "Bank transaction URI")
	explanationsCreateCmd.Flags().StringVar(&expBankAccount, "bank-account", "", "Bank account URI")
	explanationsCreateCmd.Flags().StringVar(&expDatedOn, "date", "", "Explanation date (YYYY-MM-DD)")
	explanationsCreateCmd.Flags().StringVar(&expGrossValue, "value", "", "Gross value")
	explanationsCreateCmd.Flags().StringVar(&expCategory, "category", "", "Category URI")
	explanationsCreateCmd.Flags().StringVar(&expDescription, "description", "", "Description")
	explanationsCreateCmd.Flags().StringVar(&expPaidBill, "paid-bill", "", "Bill URI this payment settles")
	explanationsCreateCmd.Flags().StringVar(&expTransferAccount, "transfer-account", "", "Other bank account URI for a transfer")
	explanationsCreateCmd.Flags().StringVar(&expSalesTaxRate, "sales-tax-rate", "", "Sales tax (VAT) rate percentage, e.g. 20")
	explanationsCreateCmd.Flags().StringVar(&expManualTax, "manual-sales-tax-amount", "", "Explicit sales tax amount when a rate does not apply cleanly")
	explanationsCreateCmd.Flags().StringVar(&expCreateFile, "file", "", "Path to a receipt/invoice to attach")

	_ = explanationsCreateCmd.MarkFlagRequired("date")
	_ = explanationsCreateCmd.MarkFlagRequired("value")
}
